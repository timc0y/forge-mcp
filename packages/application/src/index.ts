import {
  ForgeError,
  ids,
  nextRevision,
  type ActorRef,
  type ArtifactId,
  type CredentialProfileId,
  type OperationId,
  type ProcessId,
  type ProjectId,
  type RepositoryRef,
  type SnapshotId,
  type TenantId,
  type Workspace,
  type WorkspaceFailureDetails,
  type WorkspaceId
} from '@forge/core';
import { assertCommandAllowed, classifyCommand, nonInteractiveShellEnv } from '@forge/policy';
import { parseDetection, DETECTION_SCRIPT, type ProjectDetection } from '@forge/project-detection';
import type {
  CreateSandboxInput,
  ExecInput,
  FileReadInput,
  FileWriteInput,
  ListFilesInput,
  NetworkPolicyMode,
  PatchInput,
  ProcessRecord,
  SandboxHandle,
  SandboxProvider,
  SnapshotRef
} from '@forge/sandbox-core';

export interface WorkspaceRuntimeRecord {
  workspace: Workspace;
  providerId: string;
  detection?: ProjectDetection;
  processes: Record<string, ManagedProcessEntry>;
  checks: Record<string, { name: string; command: string; startedAt: string; commit?: string; exitCode?: number; completedAt?: string; logArtifact?: ArtifactId; workspaceRevision: number }>;
  previews: Record<
    string,
    {
      port: number;
      processId: ProcessId;
      providerUrl: string;
      access: 'private' | 'tenant' | 'share-link' | 'public';
      expiresAt: string;
    }
  >;
  idempotency: Record<string, { operationId: OperationId; revision: number; processId?: ProcessId }>;
  snapshots: Record<string, WorkspaceCheckpoint>;
  /** Set only after a manifest-verified provider restore. */
  lastRecoveryVerifiedAt?: string;
  lastGitDivergence?: {
    recordedCommit?: string;
    recordedBranch?: string;
    observedCommit: string;
    observedBranch: string;
    observedAt: string;
  };
  /**
   * Dependency state tracking. Records whether dependencies are known-good for
   * the current lockfile hash, so recovery can distinguish "deps installed" from
   * "deps lost" without re-running an install.
   */
  dependencyState?: {
    lockfileHash: string;
    installedAt: string;
    usable: boolean;
  };
}

export interface ManagedProcessEntry {
  command: string;
  port?: number;
  /** ISO timestamp when the process was started. */
  startedAt: string;
  /** ISO timestamp when the process reached a terminal state. */
  completedAt?: string;
  /** Exit code when the process has terminated. */
  exitCode?: number;
  /** Whether the command was classified as mutating the filesystem. */
  mutatesFilesystem: boolean;
  /** Snapshot id of the checkpoint captured after a successful mutating process. */
  checkpointAfter?: SnapshotId;
  /** Artifact id of the persisted log output. */
  logArtifact?: ArtifactId;
}

/** Schema-safe dependency state for strict MCP hosts that reject null. */
export type DependencyStateView = {
  status: 'unknown' | 'ready' | 'missing' | 'unusable';
  reason: string;
  lockfileHash?: string;
  installedAt?: string;
  usable: boolean;
};

export function dependencyStateView(
  state?: { lockfileHash: string; installedAt: string; usable: boolean } | null
): DependencyStateView {
  if (!state) {
    return { status: 'unknown', reason: 'not_observed', usable: false };
  }
  if (state.usable) {
    return {
      status: 'ready',
      reason: 'installed',
      lockfileHash: state.lockfileHash,
      installedAt: state.installedAt,
      usable: true
    };
  }
  return {
    status: 'unusable',
    reason: 'install_not_visible',
    lockfileHash: state.lockfileHash,
    installedAt: state.installedAt,
    usable: false
  };
}

export function managedProcessStatus(
  entry: ManagedProcessEntry
): 'running' | 'exited' | 'failed' | 'cancelled' {
  if (!entry.completedAt) return 'running';
  if (entry.exitCode === 0) return 'exited';
  if (entry.exitCode === 124) return 'cancelled';
  return 'failed';
}

export function workspaceAllowedNextActions(record: WorkspaceRuntimeRecord): string[] {
  const active = Object.entries(record.processes).filter(([, entry]) => !entry.completedAt);
  if (active.length > 0) {
    return [
      'forge_process_wait',
      'forge_process_list',
      'forge_process_logs',
      'forge_process_stop'
    ];
  }
  if (!['ready', 'busy'].includes(record.workspace.state)) {
    return ['forge_workspace_get'];
  }
  const deps = dependencyStateView(record.dependencyState);
  if (deps.status !== 'ready') {
    return [
      'forge_deps_install',
      'forge_shell',
      'forge_git_status',
      'forge_workspace_get'
    ];
  }
  return [
    'forge_shell',
    'forge_git_status',
    'forge_git_commit',
    'forge_submit',
    'forge_workspace_get'
  ];
}

interface WorkspaceCheckpoint extends SnapshotRef {
  // Optional only for checkpoints persisted before manifest-backed recovery.
  // They are upgraded after a confirmed mount-loss restore, never trusted
  // for a destructive restore while a live workspace exists.
  manifest?: {
    commit: string;
    branch?: string;
    /** Hash of the durable filesystem contents captured under /workspace. */
    workspaceHash: string;
    /** Legacy tar-v1 hashes include FUSE mount metadata; content-v2 does not. */
    workspaceHashAlgorithm?: 'tar-v1' | 'content-v2';
  };
}

export interface CreateWorkspaceInput {
  workspaceId?: WorkspaceId;
  tenantId: TenantId;
  projectId: ProjectId;
  repository: RepositoryRef;
  ref: string;
  credentialProfileId?: CredentialProfileId;
  runtimeProfile: 'node-22' | 'node-24' | 'python-3.13' | 'general-purpose';
  persistence: 'ephemeral' | 'snapshot_on_idle' | 'persistent';
  bootstrap: boolean;
  idempotencyKey: string;
  actor: ActorRef;
}

export interface RepositoryCloneSource {
  url: string;
  authorizationHeader?: string;
}

// Callbacks that plug the per-repo dependency cache into provisioning without
// pulling D1/R2/coordinator specifics into this package (same pattern as the
// snapshot `restore` callback). `restore` returns true when it warmed the
// dependency dirs from the shared cache; `populate` is fire-and-forget (the
// coordinator schedules it on waitUntil) and is only called on a cache miss.
export interface DepsCacheHooks {
  restore: (lockfileHash: string) => Promise<boolean>;
  populate: (lockfileHash: string) => void;
}

// The lockfile whose hash keys the dependency cache, per detected package
// manager. Returns null when there is nothing stable to key on (skip the cache).
function lockfileFor(packageManager: ProjectDetection['packageManager']): string | null {
  switch (packageManager) {
    case 'pnpm':
      return 'pnpm-lock.yaml';
    case 'npm':
      return 'package-lock.json';
    case 'yarn':
      return 'yarn.lock';
    case 'bun':
      return 'bun.lock';
    case 'uv':
      return 'uv.lock';
    case 'pip':
      return 'requirements.txt';
    default:
      return null;
  }
}

// Candidate lockfiles hashed by the combined provision probe, ordered so a single
// pass covers every package manager `lockfileFor` can name.
const LOCKFILE_CANDIDATES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'uv.lock', 'requirements.txt'];

// One post-clone exec that emits HEAD, branch, per-lockfile sha256, and the project
// detection JSON in a single delimited block — folding four container round-trips
// (git rev-parse, git branch, sha256sum, detection) into one. Parsed Worker-side by
// `parseProvisionProbe`.
const PROVISION_PROBE_COMMAND = [
  'echo ===FORGE_HEAD===',
  'git rev-parse HEAD',
  'echo ===FORGE_BRANCH===',
  'git branch --show-current',
  'echo ===FORGE_LOCKFILE===',
  `for f in ${LOCKFILE_CANDIDATES.join(' ')}; do [ -f "$f" ] && echo "$f $(sha256sum "$f" | cut -d' ' -f1)"; done`,
  'echo ===FORGE_DETECTION===',
  DETECTION_SCRIPT
].join('\n');

export interface ProvisionProbe {
  head: string;
  branch: string;
  lockfileHashes: Record<string, string>;
  detection: ProjectDetection;
}

// Pure parser for the combined probe's stdout. Splits on the sentinel markers and
// reuses `parseDetection` for the trailing JSON section.
export function parseProvisionProbe(stdout: string): ProvisionProbe {
  const markers = ['===FORGE_HEAD===', '===FORGE_BRANCH===', '===FORGE_LOCKFILE===', '===FORGE_DETECTION==='];
  const section = (name: string): string => {
    const start = stdout.indexOf(name);
    if (start === -1) return '';
    const from = start + name.length;
    let end = stdout.length;
    for (const m of markers) {
      const i = stdout.indexOf(m, from);
      if (i !== -1 && i < end) end = i;
    }
    return stdout.slice(from, end).trim();
  };
  const lockfileHashes: Record<string, string> = {};
  for (const line of section('===FORGE_LOCKFILE===').split('\n')) {
    const [name, hash] = line.trim().split(/\s+/);
    if (name && hash) lockfileHashes[name] = hash;
  }
  return {
    head: section('===FORGE_HEAD==='),
    branch: section('===FORGE_BRANCH==='),
    lockfileHashes,
    detection: parseDetection(section('===FORGE_DETECTION==='))
  };
}

// --- Progressive (per-file) diff paging ------------------------------------
//
// A diff is the one Forge result whose size is dictated by the user's
// repository rather than by anything Forge chooses. A single generated file, a
// vendored bundle or a large text/content change can run to megabytes, and
// returning that in one tool result either blows the client's limit outright or
// buries the answer. Worse, the previous behaviour truncated silently at the
// exec output cap and then hashed the TRUNCATED text — so a push could be
// approved against a diff nobody had actually seen in full.
//
// So the diff is served a page of FILES at a time:
//   1. `git diff --numstat -z` gives the complete file list with line counts.
//      Its size scales with the NUMBER of files, not their content, so it stays
//      small (~40 bytes/file) even for a multi-megabyte change.
//   2. A budget-aware planner picks the slice of files this page carries.
//   3. Only those files' hunks are fetched, with `-- <paths>`.
// The full-diff hash is computed inside the container (`| sha256sum`), so it
// covers the whole change on every page and never depends on what was paged in.

/** One record of `git diff --numstat -z`. Binary files report `-` for counts. */
export interface DiffFileStat {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Set for renames/copies; both paths go into the pathspec so git still renders it as a rename. */
  previousPath?: string;
}

/**
 * Parse `git diff --numstat -z` output.
 *
 * NUL-delimited rather than line-delimited on purpose: with plain `--numstat`,
 * git quote-escapes any path containing a space, quote or non-ASCII byte, and
 * un-escaping that correctly is easy to get subtly wrong. With `-z` the paths
 * arrive verbatim.
 *
 * Record shapes:
 *   normal  `<adds>\t<dels>\t<path>\0`
 *   rename  `<adds>\t<dels>\t\0<old>\0<new>\0`  — counts first, then two fields
 */
export function parseNumstatZ(raw: string): DiffFileStat[] {
  const tokens = raw.split('\0');
  const files: DiffFileStat[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    // The section may carry a leading newline from the sentinel `echo`.
    const token = (tokens[index] ?? '').replace(/^[\r\n]+/, '');
    if (!token) continue;
    const firstTab = token.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;
    const additions = token.slice(0, firstTab);
    const deletions = token.slice(firstTab + 1, secondTab);
    let path = token.slice(secondTab + 1);
    let previousPath: string | undefined;
    if (path === '') {
      // Rename/copy: the old and new paths follow as their own NUL fields.
      const from = tokens[index + 1];
      const to = tokens[index + 2];
      if (from === undefined || to === undefined) continue;
      previousPath = from;
      path = to;
      index += 2;
    }
    if (!path) continue;
    const binary = additions === '-' || deletions === '-';
    files.push({
      path,
      additions: binary ? 0 : Number.parseInt(additions, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deletions, 10) || 0,
      binary,
      ...(previousPath ? { previousPath } : {})
    });
  }
  return files;
}

// Rough per-line and per-file costs used only to decide where to cut a page.
// Measuring the real size would mean fetching it, which is the cost being
// avoided; the fetch itself is still hard-capped, so a bad estimate costs a
// slightly fuller or emptier page, never a blown limit.
const DIFF_LINE_BYTES = 64;
const DIFF_FILE_OVERHEAD_BYTES = 200;
const DIFF_BINARY_BYTES = 4_096;

export function estimateFileDiffBytes(file: DiffFileStat): number {
  if (file.binary) return DIFF_FILE_OVERHEAD_BYTES + DIFF_BINARY_BYTES;
  return DIFF_FILE_OVERHEAD_BYTES + (file.additions + file.deletions) * DIFF_LINE_BYTES;
}

export interface DiffPagePlan {
  /** Pathspecs to fetch hunks for (includes a rename's old path). */
  pathspecs: string[];
  /** Paths, in file-list order, whose hunks this page carries. */
  paths: string[];
  fromIndex: number;
  /** Index the next page starts at, or null when this page is the last. */
  nextIndex: number | null;
}

/**
 * Choose the slice of files whose hunks a page carries.
 *
 * ALWAYS selects at least one file while any remain. A file whose own diff
 * exceeds the entire budget would otherwise select nothing, the cursor would
 * never advance, and a caller following nextCursor would page forever. Such a
 * file is instead returned alone and truncated, with the result saying so.
 */
export function planDiffPage(
  files: DiffFileStat[],
  startIndex: number,
  maxBytes: number,
  maxFiles: number
): DiffPagePlan {
  const fromIndex = Math.max(0, Math.min(Math.trunc(startIndex) || 0, files.length));
  const paths: string[] = [];
  const pathspecs: string[] = [];
  let spent = 0;
  let index = fromIndex;
  while (index < files.length && paths.length < maxFiles) {
    const file = files[index];
    if (!file) break;
    const cost = estimateFileDiffBytes(file);
    if (paths.length > 0 && spent + cost > maxBytes) break;
    paths.push(file.path);
    pathspecs.push(file.path);
    if (file.previousPath) pathspecs.push(file.previousPath);
    spent += cost;
    index += 1;
  }
  return { pathspecs, paths, fromIndex, nextIndex: index < files.length ? index : null };
}

export interface DiffPageResult {
  diff: string;
  files: { path: string; additions: number; deletions: number; binary: boolean }[];
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  pageFiles: string[];
  cursor?: string;
  nextCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
  fileListTruncated?: boolean;
  diffHash?: string;
  note: string;
}

/**
 * One plain sentence telling the caller what it is holding and how to get the
 * rest. The model acts on this, so it states the next call rather than merely
 * flagging that the result is partial.
 */
export function diffPageNote(state: {
  shown: number;
  total: number;
  hasMore: boolean;
  truncated: boolean;
  fileListTruncated?: boolean;
}): string {
  const parts: string[] = [];
  if (state.total === 0) return 'No changes.';
  parts.push(
    state.hasMore || state.shown < state.total
      ? `Showing the diff for ${state.shown} of ${state.total} changed files; every changed file is listed in \`files\`.`
      : `Showing the diff for all ${state.total} changed file${state.total === 1 ? '' : 's'}.`
  );
  if (state.hasMore) parts.push('Call again with `cursor: nextCursor` for the next page, or pass `paths` to jump to specific files.');
  if (state.truncated) parts.push('This page\'s diff was cut short — usually one file too large to include whole. Read that file with forge_files_read, or re-request it alone with `paths`; paging will not return the missing part.');
  if (state.fileListTruncated) parts.push('The change touches too many files to list them all; narrow with `paths`.');
  return parts.join(' ');
}

function repositorySlug(repository: RepositoryRef): string {
  if (
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name)
  ) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'Invalid GitHub repository owner or name.',
      retryable: false
    });
  }
  return `${repository.owner}/${repository.name}`;
}

function assertRef(ref: string): void {
  if (!ref || ref.length > 255 || /[\s~^:?*[\\]/.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'Invalid Git ref.',
      retryable: false
    });
  }
}

function sandboxProviderId(workspaceId: WorkspaceId): string {
  return `forge-${workspaceId.slice(3, 25)}`.toLowerCase();
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function assertRuntimeProfile(handle: SandboxHandle, profile: CreateWorkspaceInput['runtimeProfile']): Promise<void> {
  if (profile === 'python-3.13') {
    const result = await handle.exec({ command: 'python3 --version', cwd: '/workspace', timeoutMs: 30_000, outputLimitBytes: 10_000, sessionId: 'system', networkPolicy: 'deny_all' });
    const pythonVersion = result.stdout.trim() || result.stderr.trim();
    if (result.exitCode !== 0 || !pythonVersion.startsWith('Python 3.13.')) {
      throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: `Requested ${profile}, but the provisioned runtime reports ${pythonVersion || 'no Python version'}.`, retryable: false, details: { requestedRuntime: profile, observedPythonVersion: pythonVersion || null, stage: 'runtime_verification' } });
    }
    return;
  }
  if (!profile.startsWith('node-')) return;
  const expectedMajor = profile.slice('node-'.length).split('.')[0];
  const result = await handle.exec({ command: 'node --version && corepack --version', cwd: '/workspace', timeoutMs: 30_000, outputLimitBytes: 10_000, sessionId: 'system', networkPolicy: 'deny_all' });
  const nodeVersion = result.stdout.split('\n')[0]?.trim() ?? '';
  if (result.exitCode !== 0 || !nodeVersion.startsWith(`v${expectedMajor}.`)) {
    throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: `Requested ${profile}, but the provisioned runtime reports ${nodeVersion || 'no Node version'}.`, retryable: false, details: { requestedRuntime: profile, observedNodeVersion: nodeVersion || null, stage: 'runtime_verification' } });
  }
}

function assertForgeBranch(branch: string): void {
  if (
    !/^forge\/[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/u.test(branch) ||
    branch.includes('..') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock')
  ) {
    throw new ForgeError({
      code: 'FORGE_GIT_PUSH_BLOCKED',
      message: 'Forge branches must use the forge/<task> namespace.',
      retryable: false
    });
  }
}

async function sha256Text(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Bound on a single provider.create(): a hung backend must surface as a
// retryable error and let the workflow retry/compensate, not silently hang the
// provision step until the whole workflow times out (and dies before its catch).
const PROVIDER_CREATE_TIMEOUT_MS = 120_000;

// Race a promise against a timeout that rejects with a retryable ForgeError. The
// underlying promise keeps running (the SandboxProvider contract has no
// cancellation), but the provision step fails fast instead of hanging. When the
// timeout fires, `onTimeout` runs so the caller can best-effort reclaim any
// resource the still-running promise may leak (e.g. an orphaned container).
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        if (onTimeout) {
          try {
            onTimeout();
          } catch {
            // Cleanup is best-effort and must never mask the timeout rejection.
          }
        }
        reject(
          new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: 'Workspace provisioning timed out.',
            retryable: true,
            details: { stage: 'provision', phase, timeoutMs }
          })
        );
      },
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}


// Routes sandbox work across backends (e.g. a self-hosted box vs Cloudflare).
// `selectForCreate` decides which backend a new workspace lands on (with its own
// health-check + fallback); `forKind` resolves the backend a workspace is
// already bound to, read from its persisted provider.kind.
export interface SandboxRouter {
  readonly default: SandboxProvider;
  selectForCreate(): Promise<SandboxProvider>;
  forKind(kind: SandboxProvider['kind']): SandboxProvider;
}

// Wrap a single provider so the app can always talk to a router internally,
// keeping the common (Cloudflare-only) case and existing tests unchanged.
function singleProviderRouter(provider: SandboxProvider): SandboxRouter {
  return {
    default: provider,
    async selectForCreate() {
      return provider;
    },
    forKind() {
      return provider;
    }
  };
}

export class ForgeApplicationService {
  private readonly router: SandboxRouter;

  constructor(sandbox: SandboxProvider | SandboxRouter) {
    this.router = 'selectForCreate' in sandbox ? sandbox : singleProviderRouter(sandbox);
  }

  private providerFor(record: WorkspaceRuntimeRecord): SandboxProvider {
    return this.router.forKind(record.workspace.provider.kind);
  }

  private restoreInput(record: WorkspaceRuntimeRecord): CreateSandboxInput {
    return {
      providerId: record.providerId,
      runtimeProfile: record.workspace.runtimeProfile as CreateWorkspaceInput['runtimeProfile'],
      labels: {
        workspaceId: record.workspace.id,
        tenantId: record.workspace.tenantId,
        repository: repositorySlug(record.workspace.repository)
      },
      idleTimeout: '10m'
    };
  }

  private async gitIdentity(handle: SandboxHandle): Promise<{ commit: string; branch?: string }> {
    const result = await handle.exec({
      command: 'git rev-parse HEAD && git branch --show-current',
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
      outputLimitBytes: 10_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0 || result.truncated) {
      throw new ForgeError({
        code: 'FORGE_GIT_DIRTY',
        message: 'Forge could not read the checked-out Git identity.',
        retryable: false,
        details: { truncated: result.truncated }
      });
    }
    const [commit = '', branch = ''] = result.stdout.trim().split('\n');
    if (!commit) {
      throw new ForgeError({
        code: 'FORGE_GIT_DIRTY',
        message: 'Workspace Git state has no checked-out commit.',
        retryable: false
      });
    }
    return { commit, ...(branch ? { branch } : {}) };
  }

  private noteGitDivergence(
    record: WorkspaceRuntimeRecord,
    observed: { commit?: string; branch?: string }
  ): void {
    record.lastGitDivergence = {
      recordedCommit: record.workspace.currentCommit,
      recordedBranch: record.workspace.currentBranch,
      observedCommit: observed.commit ?? '',
      observedBranch: observed.branch ?? '',
      observedAt: new Date().toISOString()
    };
    record.workspace.updatedAt = new Date().toISOString();
  }

  /**
   * A sandbox sleep removes its workspace mount.  Do not let a caller observe
   * an empty replacement workspace: verify the stable workspace marker and
   * the recorded Git identity, then restore the durable active checkpoint.
   */
  private async inspectWorkspace(
    handle: SandboxHandle,
    record: WorkspaceRuntimeRecord
  ): Promise<{
    state: 'matches' | 'mount_missing' | 'diverged' | 'unavailable';
    commit?: string;
    branch?: string;
    diagnostic?: { code: string; providerCode?: string; operation?: string };
  }> {
    const diagnostic = (error: unknown): { code: string; providerCode?: string; operation?: string } => {
      if (error instanceof ForgeError) {
        const details = error.details as Record<string, unknown> | undefined;
        return {
          code: error.code,
          ...(typeof details?.providerCode === 'string' ? { providerCode: details.providerCode } : {}),
          ...(typeof details?.operation === 'string' ? { operation: details.operation } : {})
        };
      }
      return { code: 'UNKNOWN' };
    };
    // Do not start recovery by opening a shell session. After a Sandbox idle
    // restart the session RPC can wait indefinitely before its command timeout
    // applies, which prevents Forge from noticing the lost FUSE overlay. File
    // APIs wake a sandbox independently, so first ask for our immutable marker.
    const markerFile = await handle.readFile({
      path: '/workspace/forge/workspace-id',
      maxBytes: 512
    }).catch((error) => ({ error }));
    if ('error' in markerFile) {
      const markerDiagnostic = diagnostic(markerFile.error);
      if (markerDiagnostic.code !== 'FORGE_FILE_NOT_FOUND') {
        return { state: 'unavailable', diagnostic: markerDiagnostic };
      }
      // The image deliberately seeds empty directories, so a missing marker
      // alone is insufficient evidence. Enumerate through the file API and
      // restore only when there is no checkout and no file/symlink that could
      // contain user data. A truncated listing is intentionally ambiguous.
      const scaffold = await handle.listFiles({
        path: '/workspace',
        depth: 16,
        limit: 4_000
      }).catch((error) => ({ error }));
      if ('error' in scaffold) return { state: 'unavailable', diagnostic: diagnostic(scaffold.error) };
      if (scaffold.truncated) {
        return { state: 'unavailable', diagnostic: { code: 'FORGE_OUTPUT_TRUNCATED', operation: 'workspace_scaffold_probe' } };
      }
      const hasCheckout = scaffold.entries.some((entry) => entry.path === '/workspace/repo/.git' || entry.path.startsWith('/workspace/repo/.git/'));
      const hasFileLikeContent = scaffold.entries.some((entry) => entry.type === 'file' || entry.type === 'symlink');
      if (!hasCheckout && !hasFileLikeContent) return { state: 'mount_missing' };
      // `readFile()` can transiently miss a file that is visible through the
      // restored FUSE overlay. A real checkout is never part of the base image,
      // so only in that narrow case continue to the independent shell marker
      // check below. Any other residual file-like content remains ambiguous and
      // is deliberately fail-closed.
      if (!hasCheckout) {
        return { state: 'unavailable', diagnostic: { code: 'FORGE_WORKSPACE_MARKER_MISSING', operation: 'workspace_scaffold_probe' } };
      }
    }
    if (!('error' in markerFile) && markerFile.truncated) {
      return { state: 'unavailable', diagnostic: { code: 'FORGE_OUTPUT_TRUNCATED', operation: 'workspace_marker_read' } };
    }
    const marker = await handle.exec({
      command: `test "$(cat /workspace/forge/workspace-id 2>/dev/null)" = ${quoted(record.workspace.id)} && test -d /workspace/repo/.git`,
      cwd: '/workspace',
      timeoutMs: 30_000,
      outputLimitBytes: 10_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch((error) => ({ error }));
    if ('error' in marker) return { state: 'unavailable', diagnostic: diagnostic(marker.error) };
    if (marker.exitCode !== 0 || marker.truncated) return { state: 'unavailable', diagnostic: { code: marker.truncated ? 'FORGE_OUTPUT_TRUNCATED' : 'FORGE_WORKSPACE_MARKER_MISSING', operation: 'workspace_marker_probe' } };
    const identity = await this.gitIdentity(handle).catch((error) => ({ error }));
    if ('error' in identity) return { state: 'unavailable', diagnostic: diagnostic(identity.error) };
    if (!record.workspace.currentCommit) return { state: 'unavailable', diagnostic: { code: 'FORGE_GIT_DIRTY', operation: 'workspace_git_identity' } };
    if (
      identity.commit === record.workspace.currentCommit &&
      identity.branch === record.workspace.currentBranch
    ) return { state: 'matches', ...identity };
    return { state: 'diverged', ...identity };
  }

  private async quarantineRecovery(
    record: WorkspaceRuntimeRecord,
    snapshotId: string,
    code: 'FORGE_SNAPSHOT_INCOMPATIBLE' | 'FORGE_WORKSPACE_GIT_STATE_DIVERGED',
    message: string
  ): Promise<never> {
    await this.providerFor(record).destroy(record.providerId).catch(() => undefined);
    record.workspace.state = 'failed';
    record.workspace.failure = { stage: 'recovery', code, message, retryable: false };
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = new Date().toISOString();
    throw new ForgeError({
      code,
      message,
      retryable: false,
      details: { workspaceId: record.workspace.id, snapshotId }
    });
  }

  private async recoverActiveCheckpoint(record: WorkspaceRuntimeRecord): Promise<SandboxHandle> {
    const snapshotId = record.workspace.activeSnapshotId;
    if (!snapshotId) {
      throw new ForgeError({
        code: 'FORGE_SNAPSHOT_INCOMPATIBLE',
        message: 'Forge cannot recover this workspace because it has no durable active checkpoint.',
        retryable: false,
        details: { workspaceId: record.workspace.id, activeSnapshotId: snapshotId ?? null }
      });
    }
    const snapshot = record.snapshots[snapshotId];
    if (!snapshot) {
      throw new ForgeError({
        code: 'FORGE_SNAPSHOT_INCOMPATIBLE',
        message: 'Forge cannot recover this workspace because its active checkpoint is unavailable.',
        retryable: false,
        details: { workspaceId: record.workspace.id, activeSnapshotId: snapshotId }
      });
    }
    const legacySnapshot = !snapshot.manifest;
    if (
      snapshot.manifest &&
      (
        snapshot.manifest.commit !== record.workspace.currentCommit ||
        snapshot.manifest.branch !== record.workspace.currentBranch
      )
    ) {
      return this.quarantineRecovery(
        record,
        snapshotId,
        'FORGE_WORKSPACE_GIT_STATE_DIVERGED',
        'The active checkpoint Git identity differs from the durable workspace record.'
      );
    }
    let restored: SandboxHandle;
    let restoredManifest: NonNullable<WorkspaceCheckpoint['manifest']>;
    try {
      restored = await this.providerFor(record).restore(snapshot, this.restoreInput(record));
      restoredManifest = await this.workspaceManifest(restored);
    } catch (error) {
      return this.quarantineRecovery(
        record,
        snapshotId,
        'FORGE_SNAPSHOT_INCOMPATIBLE',
        'Forge could not restore and verify the durable workspace checkpoint after a sandbox restart.'
      );
    }
    if (legacySnapshot) {
      // Existing workspaces predate filesystem manifests. A confirmed missing
      // mount is safe to restore; immediately promote the restored checkpoint
      // to a manifest-backed record, but never adopt a different Git identity.
      if (
        restoredManifest.commit !== record.workspace.currentCommit ||
        restoredManifest.branch !== record.workspace.currentBranch
      ) {
        return this.quarantineRecovery(
          record,
          snapshotId,
          'FORGE_WORKSPACE_GIT_STATE_DIVERGED',
          'The legacy checkpoint restores a different Git identity than the recorded workspace.'
        );
      }
      record.snapshots[snapshotId] = { ...snapshot, manifest: restoredManifest };
    }
    const expectedManifest = record.snapshots[snapshotId]!.manifest;
    if (!expectedManifest) {
      return this.quarantineRecovery(
        record,
        snapshotId,
        'FORGE_SNAPSHOT_INCOMPATIBLE',
        'Forge could not establish a durable filesystem manifest for the restored checkpoint.'
      );
    }
    if (
      restoredManifest.commit !== expectedManifest.commit ||
      restoredManifest.branch !== expectedManifest.branch ||
      restoredManifest.workspaceHashAlgorithm !== expectedManifest.workspaceHashAlgorithm ||
      restoredManifest.workspaceHash !== expectedManifest.workspaceHash
    ) {
      return this.quarantineRecovery(
        record,
        snapshotId,
        'FORGE_SNAPSHOT_INCOMPATIBLE',
        'The restored checkpoint filesystem does not match its durable manifest.'
      );
    }
    // A restored mount cannot retain running processes or their exposed ports.
    record.processes = {};
    record.previews = {};
    // Promotion establishes a manifest for an old checkpoint, but only a
    // subsequent restore of that pre-capture manifest qualifies the service
    // for a verified recovery readiness receipt.
    if (!legacySnapshot) record.lastRecoveryVerifiedAt = new Date().toISOString();
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = new Date().toISOString();
    return restored;
  }

  initializeWorkspace(input: CreateWorkspaceInput): WorkspaceRuntimeRecord {
    assertRef(input.ref);
    const now = new Date().toISOString();
    const id = input.workspaceId ?? ids.workspace();
    const operationId = ids.operation();
    return {
      workspace: {
        id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        repository: input.repository,
        requestedRef: input.ref,
        ...(input.credentialProfileId ? { credentialProfileId: input.credentialProfileId } : {}),
        state: 'requested',
        persistenceMode: input.persistence,
        runtimeProfile: input.runtimeProfile,
        provider: {
          // Provisional; provisionWorkspace() selects the real backend (with a
          // health-check) and rewrites this before the sandbox is created.
          kind: this.router.default.kind,
          version: this.router.default.version
        },
        revision: 1,
        createdBy: input.actor,
        createdAt: now,
        updatedAt: now
      },
      providerId: sandboxProviderId(id),
      processes: {},
      checks: {},
      previews: {},
      snapshots: {},
      dependencyState: undefined,
      idempotency: {
        [input.idempotencyKey]: { operationId, revision: 1 }
      }
    };
  }

  private defaultCloneSource(record: WorkspaceRuntimeRecord): RepositoryCloneSource {
    return { url: `https://github.com/${repositorySlug(record.workspace.repository)}.git` };
  }

  // Make pnpm available up front, otherwise `pnpm install` fails the whole
  // bootstrap with "pnpm: command not found". corepack ships with node but
  // isn't always on PATH in the sandbox image, so try it first and fall back
  // to a global npm install (npm is always present). `command -v pnpm` short-
  // circuits when it is already there. Best-effort — never fail provisioning.
  private async preparePackageManager(handle: SandboxHandle): Promise<void> {
    await handle.exec({
      command:
        'command -v pnpm >/dev/null 2>&1 || corepack prepare pnpm@9 --activate 2>/dev/null || npm install -g pnpm@9',
      cwd: '/workspace',
      timeoutMs: 120_000,
      outputLimitBytes: 20_000,
      sessionId: 'system',
      networkPolicy: 'package_install',
      environment: nonInteractiveShellEnv()
    }).catch(() => undefined);
  }

  // Clone the repository checkout into /workspace/repo. Shared by first-time
  // provisioning and by in-place checkout recovery.
  private async checkoutRepository(
    record: WorkspaceRuntimeRecord,
    handle: SandboxHandle,
    cloneSource?: RepositoryCloneSource,
    ref?: string
  ): Promise<void> {
    const source = cloneSource ?? this.defaultCloneSource(record);
    const gitConfigPath = `/workspace/tmp/gitconfig-${record.workspace.id}`;
    if (source.authorizationHeader) {
      await handle.writeFile({
        path: gitConfigPath,
        content: `[http]\n\textraHeader = ${source.authorizationHeader}\n`
      });
    }
    const clone = await handle.exec({
      command: `git clone --depth 1 --no-tags --branch ${quoted(ref ?? record.workspace.requestedRef)} ${quoted(source.url)} /workspace/repo`,
      cwd: '/workspace',
      timeoutMs: 180_000,
      outputLimitBytes: 200_000,
      sessionId: 'system',
      networkPolicy: 'development',
      environment: source.authorizationHeader
        ? { GIT_CONFIG_GLOBAL: gitConfigPath, GIT_TERMINAL_PROMPT: '0' }
        : { GIT_TERMINAL_PROMPT: '0' }
    });
    if (source.authorizationHeader) {
      await handle.exec({
        command: `rm -f ${quoted(gitConfigPath)}`,
        cwd: '/workspace',
        timeoutMs: 10_000,
        outputLimitBytes: 1_000,
        sessionId: 'system',
        networkPolicy: 'deny_all'
      }).catch(() => undefined);
    }
    if (clone.exitCode !== 0) {
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: 'Repository clone failed.',
        retryable: false,
        details: {
          stage: 'clone',
          phase: 'checkout',
          exitCode: clone.exitCode,
          durationMs: clone.durationMs,
          stderr: clone.stderr.slice(0, 4_000),
          stdout: clone.stdout.slice(0, 1_000)
        }
      });
    }
  }

  // Snapshot-first fast path: let the caller restore a prior /workspace tar, then
  // confirm the checkout is present and cheaply advance it to the requested ref.
  // Returns true only when the restored checkout is usable; any failure returns
  // false so the caller falls back to a full clone. Best-effort throughout.
  private async restoreCheckout(
    record: WorkspaceRuntimeRecord,
    handle: SandboxHandle,
    source: RepositoryCloneSource,
    restore: () => Promise<boolean>
  ): Promise<boolean> {
    try {
      const restored = await restore();
      if (!restored) return false;
      const probe = await handle.exec({
        command: 'test -d /workspace/repo/.git && echo forge_checkout_present || echo forge_checkout_missing',
        cwd: '/workspace',
        timeoutMs: 10_000,
        outputLimitBytes: 1_000,
        sessionId: 'system',
        networkPolicy: 'deny_all'
      });
      if (!probe.stdout.includes('forge_checkout_present')) return false;
      const ref = record.workspace.requestedRef;
      const gitConfigPath = `/workspace/tmp/gitconfig-${record.workspace.id}`;
      if (source.authorizationHeader) {
        await handle.writeFile({
          path: gitConfigPath,
          content: `[http]\n\textraHeader = ${source.authorizationHeader}\n`
        });
      }
      const advance = await handle.exec({
        command: `git fetch --depth 1 origin ${quoted(ref)} && git checkout ${quoted(ref)}`,
        cwd: '/workspace/repo',
        timeoutMs: 120_000,
        outputLimitBytes: 100_000,
        sessionId: 'system',
        networkPolicy: 'development',
        environment: source.authorizationHeader
          ? { GIT_CONFIG_GLOBAL: gitConfigPath, GIT_TERMINAL_PROMPT: '0' }
          : { GIT_TERMINAL_PROMPT: '0' }
      });
      if (source.authorizationHeader) {
        await handle.exec({
          command: `rm -f ${quoted(gitConfigPath)}`,
          cwd: '/workspace',
          timeoutMs: 10_000,
          outputLimitBytes: 1_000,
          sessionId: 'system',
          networkPolicy: 'deny_all'
        }).catch(() => undefined);
      }
      return advance.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Re-establish a missing repository checkout in place (used by self-heal after
   * an idle recycle dropped /workspace/repo). Re-clones over any partial state
   * and restores the workspace to `ready`. Bypasses the normal `handle` state
   * gate because the record has been marked `failed` by the caller.
   *
   * A fresh clone can only ever recover what already reached the remote — any
   * commit or edit that existed solely in the wiped container is gone. Two
   * things follow: (1) clone the agent's actual currentBranch when one is
   * tracked, not the workspace's original requestedRef, so a branch that was
   * already fully pushed comes back as itself instead of silently dumping the
   * agent back on main; (2) if hasUnpushedWork was true going into recovery,
   * that local-only work cannot be a clone away — surface this loudly
   * (FORGE_CHECKOUT_DATA_LOSS) instead of quietly reporting `ready` as if
   * nothing happened, which is what let "Forge reverted my branch to main"
   * go unnoticed until an agent stumbled onto it downstream.
   */
  async recoverCheckout(
    record: WorkspaceRuntimeRecord,
    cloneSource?: RepositoryCloneSource
  ): Promise<void> {
    const hadUnpushedWork = record.workspace.hasUnpushedWork === true;
    const lostBranch = record.workspace.currentBranch;
    const recoverRef = lostBranch ?? record.workspace.requestedRef;
    const handle = await this.providerFor(record).get(record.providerId);
    await handle.exec({
      command: 'rm -rf /workspace/repo',
      cwd: '/workspace',
      timeoutMs: 30_000,
      outputLimitBytes: 1_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch(() => undefined);
    // Prefer recloning the branch the agent was actually on — it may already
    // be fully pushed, in which case this is a lossless recovery. Fall back to
    // the original ref only when that branch no longer exists upstream either
    // (never pushed, or since deleted).
    try {
      await this.checkoutRepository(record, handle, cloneSource, recoverRef);
    } catch (cloneError) {
      if (recoverRef === record.workspace.requestedRef) throw cloneError;
      await this.checkoutRepository(record, handle, cloneSource, record.workspace.requestedRef);
    }
    await this.preparePackageManager(handle);
    const checkedAt = new Date().toISOString();
    record.workspace.state = 'ready';
    record.workspace.checkout = { healthy: true, checkedAt };
    record.workspace.failure = undefined;
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = checkedAt;
    if (hadUnpushedWork) {
      // The clone above recovered at most what was on the remote branch — any
      // commit or edit that only ever existed in the wiped container is gone.
      // Reflect that in the record (hasUnpushedWork is now meaningless: there
      // is no local-only work left to describe) and force the caller to
      // surface the loss rather than treat this as an ordinary self-heal.
      record.workspace.hasUnpushedWork = false;
      record.workspace.dataLoss = {
        at: checkedAt,
        detail: `Checkout recovery re-cloned ${lostBranch ?? record.workspace.requestedRef} from the remote after the container was recycled. Any commits or edits that existed only in that container and were never pushed are gone.`
      };
      throw new ForgeError({
        code: 'FORGE_CHECKOUT_DATA_LOSS',
        message: `The workspace container was recycled and its checkout had to be re-cloned from the remote. Uncommitted or unpushed work on ${lostBranch ?? '(unknown branch)'} was lost — it is not recoverable. The workspace is usable again, but re-check forge_git_status and re-apply any lost changes.`,
        retryable: false,
        details: { workspaceId: record.workspace.id, lostBranch, recoveredRef: recoverRef }
      });
    }
  }

  async provisionWorkspace(
    record: WorkspaceRuntimeRecord,
    bootstrap: boolean,
    onStateChange: (record: WorkspaceRuntimeRecord) => Promise<void> = async () => undefined,
    cloneSource?: RepositoryCloneSource,
    restore?: () => Promise<boolean>,
    depsCache?: DepsCacheHooks
  ): Promise<WorkspaceRuntimeRecord> {
    if (record.workspace.state === 'ready') return record;
    if (!['requested', 'provisioning'].includes(record.workspace.state)) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_CONFLICT',
        message: `Workspace cannot be provisioned from ${record.workspace.state}.`,
        retryable: false
      });
    }

    record.workspace.state = 'provisioning';
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = new Date().toISOString();
    await onStateChange(record);

    try {
      // Pick the backend now (self-hosted if healthy, else Cloudflare) and
      // record it so every later operation on this workspace routes to the same
      // place. Transparent to the caller — Forge chooses.
      const provider = await this.router.selectForCreate();
      record.workspace.provider = { kind: provider.kind, version: provider.version };
      // container_create is deterministically keyed on record.providerId, so a
      // create that times out (the underlying promise keeps running, since the
      // SandboxProvider contract has no cancellation) can still finish and leave a
      // live container at that exact id — orphaned, because provisioning aborts
      // before anything records success. When the timeout fires we best-effort
      // destroy(record.providerId): destroy is idempotent and no-ops on an id that
      // never materialized, and the deterministic id also lets the reaper reclaim
      // it later if this destroy is itself lost. See withTimeout's onTimeout hook.
      const createPromise = provider.create({
        providerId: record.providerId,
        runtimeProfile: record.workspace.runtimeProfile as CreateWorkspaceInput['runtimeProfile'],
        labels: {
          workspaceId: record.workspace.id,
          tenantId: record.workspace.tenantId,
          repository: repositorySlug(record.workspace.repository)
        },
        idleTimeout: '10m'
      });
      const handle = await withTimeout(
        createPromise,
        PROVIDER_CREATE_TIMEOUT_MS,
        'container_create',
        () => {
          console.warn('forge_provision_create_timeout_orphan', {
            workspaceId: record.workspace.id,
            providerId: record.providerId,
            provider: provider.kind
          });
          // Attach cleanup to the still-running create so we destroy whatever it
          // eventually produces; also fire an immediate destroy in case the
          // container is already up. Both are best-effort and must never throw.
          createPromise
            .then(
              () => provider.destroy(record.providerId).catch(() => undefined),
              () => undefined
            )
            .catch(() => undefined);
          provider.destroy(record.providerId).catch(() => undefined);
        }
      );

      const source = cloneSource ?? this.defaultCloneSource(record);

      // Snapshot-first: if a prior /workspace tar can be restored, skip the ~75s
      // clone+install and cheaply advance the warm checkout to the requested ref.
      // Any failure falls through to the full clone+install path below.
      const usedSnapshot = restore
        ? await this.restoreCheckout(record, handle, source, restore)
        : false;

      if (usedSnapshot) {
        await this.preparePackageManager(handle);
      } else {
        // Clone and pnpm pre-activation are independent — run them concurrently.
        await Promise.all([
          this.checkoutRepository(record, handle, source),
          this.preparePackageManager(handle)
        ]);
      }

      record.workspace.state = 'bootstrapping';
      record.workspace.revision = nextRevision(record.workspace.revision);
      record.workspace.updatedAt = new Date().toISOString();
      await onStateChange(record);

      // One combined exec reads everything the post-clone happy path needs: HEAD,
      // branch, project detection, and per-lockfile hashes — folding four container
      // round-trips into a single one.
      const probe = await handle.exec({
        command: PROVISION_PROBE_COMMAND,
        cwd: '/workspace/repo',
        timeoutMs: 30_000,
        outputLimitBytes: 100_000,
        sessionId: 'system',
        networkPolicy: 'deny_all'
      });
      // Guard the probe before trusting its output. A non-zero exit (or a probe
      // that produced no HEAD) means the checkout is not actually in a usable
      // state — flipping to `ready` here would strand the workspace at a hollow
      // `ready` with an empty currentCommit. Throw a retryable provisioning error
      // instead so the workflow's retry/compensation path runs (→ `failed` +
      // slot release). Note: an empty branch is legitimate (a tag/SHA ref checks
      // out in detached HEAD); currentBranch falls back to the requested ref below.
      const parsedProbe = parseProvisionProbe(probe.stdout);
      if (probe.exitCode !== 0 || !parsedProbe.head) {
        throw new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'Workspace provisioning probe failed.',
          retryable: true,
          details: {
            stage: 'provision',
            phase: 'probe',
            exitCode: probe.exitCode,
            truncated: probe.truncated,
            reason: parsedProbe.head ? 'probe_exit_nonzero' : 'empty_head',
            stderr: probe.stderr.slice(0, 4_000),
            stdout: probe.stdout.slice(0, 1_000)
          }
        });
      }
      const detection = parsedProbe.detection;
      record.detection = detection;

      // Per-repo dependency cache: when this was a cold provision (no
      // per-workspace snapshot restored) and the deps cache is wired, try to warm
      // node_modules from the shared, content-keyed cache before installing. A hit
      // turns the install into a fast --prefer-offline verify; a miss populates the
      // cache after a successful install. Best-effort — never blocks provisioning.
      // The lockfile hash comes from the combined probe above (no extra exec).
      let depsRestored = false;
      let lockfileHash: string | null = null;
      if (bootstrap && detection.installCommand && depsCache && !usedSnapshot) {
        const lockfile = lockfileFor(detection.packageManager);
        if (lockfile) {
          const out = parsedProbe.lockfileHashes[lockfile];
          if (out && /^[a-f0-9]{64}$/.test(out)) {
            lockfileHash = out;
            depsRestored = await depsCache.restore(out).catch(() => false);
          }
        }
      }

      // A successful deps-cache restore already placed node_modules keyed by this
      // exact lockfile hash, so the install is redundant — skip it (the ~75s win).
      // A corrupt/partial restore makes restoreDepsFromR2 return false, so we only
      // skip when the warm tree really landed; otherwise the full install runs.
      if (bootstrap && detection.installCommand && !depsRestored) {
        const runInstall = (command: string) => handle.exec({
          command,
          cwd: '/workspace/repo',
          timeoutMs: 600_000,
          outputLimitBytes: 500_000,
          sessionId: 'system',
          networkPolicy: 'package_install'
        });

        let install = await runInstall(detection.installCommand);
        let installedCommand = detection.installCommand;
        // A --frozen-lockfile / --immutable install refuses when the lockfile is
        // out of sync with the manifest (a classic `overrides` mismatch). Rather
        // than fail the whole workspace, retry once with the lenient command so
        // dependencies still land (it may update the lockfile in-tree).
        if (install.exitCode !== 0 && detection.installFallbackCommand) {
          const fallback = await runInstall(detection.installFallbackCommand);
          if (fallback.exitCode === 0) {
            install = fallback;
            installedCommand = detection.installFallbackCommand;
          } else {
            install = fallback;
          }
        }

        if (install.exitCode !== 0) {
          // Dependency install is best-effort: a bootstrap that cannot resolve
          // deps must NOT sink the workspace. Bring it up `ready` with a
          // non-fatal warning so the agent can inspect the checkout, fix the
          // lockfile, and re-run the install — exactly what a human would do.
          record.workspace.bootstrapWarning = {
            phase: 'dependency_install',
            message: 'Dependency install did not complete; the workspace is usable but node_modules may be incomplete.',
            detail: (install.stderr || install.stdout || '').slice(0, 2_000)
          };
        } else {
          // Cache miss: install just built node_modules from scratch — hand it to
          // the shared cache so the next workspace of this repo+lockfile skips it.
          // Only cache a tree built by the strict, lockfile-pinned command; a
          // lenient fallback may not match the committed lockfile hash.
          if (depsCache && !depsRestored && lockfileHash && installedCommand === detection.installCommand) {
            depsCache.populate(lockfileHash);
          }
        }
      }

      // HEAD/branch were captured by the combined probe above; install never
      // moves them, so this immutable identity is the task's durable base.
      record.workspace.currentCommit = parsedProbe.head;
      // `git branch --show-current` is intentionally empty for a tag or a
      // detached commit.  Keep that fact rather than mislabelling the
      // requested ref as a checked-out branch.
      record.workspace.currentBranch = parsedProbe.branch || undefined;
      record.workspace.baseCommit = parsedProbe.head;
      record.workspace.initialHeadCommit = parsedProbe.head;
      record.workspace.lastPushedCommit = parsedProbe.head;
      record.workspace.lastPushedBranch = parsedProbe.branch || undefined;
      await handle.writeFile({
        path: '/workspace/forge/workspace-id',
        content: `${record.workspace.id}\n`
      });
      // A workspace is not ready until its clone/bootstrap state is outside the
      // disposable container.  This checkpoint is also the sleep/restart base.
      await this.checkpoint(record, `initial-${record.workspace.id}`, handle);
      record.workspace.state = 'ready';
      record.workspace.failure = undefined;
      record.workspace.revision = nextRevision(record.workspace.revision);
      record.workspace.updatedAt = new Date().toISOString();
      await onStateChange(record);
      return record;
    } catch (error) {
      await this.providerFor(record).destroy(record.providerId).catch(() => undefined);
      const forgeError = error instanceof ForgeError
        ? error
        : new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: 'Workspace provisioning failed.',
            retryable: true,
            details: {
              stage: 'provision',
              reason: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
              cause: error instanceof Error ? error.name : 'unknown'
            }
          });
      record.workspace.state = forgeError.retryable ? 'provisioning' : 'failed';
      record.workspace.failure = {
        stage: String(forgeError.details?.stage ?? 'provision'),
        code: forgeError.code,
        message: forgeError.message,
        retryable: forgeError.retryable,
        ...(forgeError.details ? { details: forgeError.details as WorkspaceFailureDetails } : {})
      };
      record.workspace.revision = nextRevision(record.workspace.revision);
      record.workspace.updatedAt = new Date().toISOString();
      await onStateChange(record);
      throw forgeError;
    }
  }

  markProvisioningExhausted(record: WorkspaceRuntimeRecord): WorkspaceRuntimeRecord {
    if (
      record.workspace.state === 'ready' ||
      record.workspace.state === 'destroying' ||
      record.workspace.state === 'destroyed' ||
      (record.workspace.state === 'failed' && record.workspace.failure?.retryable === false)
    ) {
      return record;
    }

    record.workspace.state = 'failed';
    record.workspace.failure = record.workspace.failure
      ? { ...record.workspace.failure, retryable: false }
      : {
          stage: 'provision',
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'Workspace provisioning exhausted its retry budget.',
          retryable: false
        };
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = new Date().toISOString();
    return record;
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRuntimeRecord> {
    const record = this.initializeWorkspace(input);
    return this.provisionWorkspace(record, input.bootstrap);
  }

  /**
   * True when restoring a checkpoint would discard filesystem writes that have
   * not yet been captured (live or successfully completed mutating processes).
   */
  private hasUncheckpointedMutators(record: WorkspaceRuntimeRecord): boolean {
    return Object.values(record.processes).some(
      (entry) =>
        entry.mutatesFilesystem &&
        !entry.checkpointAfter &&
        (!entry.completedAt || entry.exitCode === 0)
    );
  }

  async handle(
    record: WorkspaceRuntimeRecord,
    options: { allowRestore?: boolean } = {}
  ): Promise<SandboxHandle> {
    const allowRestore = options.allowRestore !== false;
    if (
      record.workspace.state === 'destroyed' ||
      record.workspace.state === 'destroying'
    ) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_NOT_READY',
        message: 'Workspace is not available.',
        retryable: false
      });
    }
    if (!['ready', 'busy'].includes(record.workspace.state)) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_NOT_READY',
        message: `Workspace is ${record.workspace.state}.`,
        retryable: record.workspace.state === 'suspended'
      });
    }
    const handle = await this.providerFor(record).get(record.providerId);
    // Runtime records created before manifest-backed checkpoints (and focused
    // unit/provider adapters) still use the checkout-health path below. New
    // workspaces always have an active checkpoint before becoming ready.
    if (!record.workspace.activeSnapshotId) return handle;
    let inspection = await this.inspectWorkspace(handle, record);
    if (inspection.state === 'unavailable') {
      // A Durable Object reset mid-command often leaves process bookkeeping and
      // the sandbox briefly disagreeing. Adopt/reap tracked processes and retry
      // before failing closed as opaque UNKNOWN.
      inspection = await this.recoverUnavailableInspection(record, handle, inspection);
    }
    if (inspection.state === 'matches') return handle;
    if (inspection.state === 'diverged') {
      this.noteGitDivergence(record, inspection);
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED',
        message: 'The workspace filesystem Git state differs from Forge metadata; recovery will not overwrite it.',
        retryable: false,
        details: {
          workspaceId: record.workspace.id,
          expectedCommit: record.workspace.currentCommit ?? null,
          expectedBranch: record.workspace.currentBranch ?? null,
          observedCommit: inspection.commit ?? null,
          observedBranch: inspection.branch ?? null,
          activeSnapshotId: record.workspace.activeSnapshotId ?? null
        }
      });
    }
    if (inspection.state === 'mount_missing') {
      // Restoring a pre-process checkpoint while a managed install/mutation is
      // still live (or finished but not yet checkpointed) discards its writes —
      // the observed "pnpm install succeeded but node_modules is gone" failure.
      if (!allowRestore || this.hasUncheckpointedMutators(record)) {
        throw new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'Workspace mount is missing, but Forge will not restore a checkpoint while managed mutating processes still have uncheckpointed filesystem writes.',
          retryable: true,
          details: {
            workspaceId: record.workspace.id,
            allowRestore,
            uncheckpointedMutators: Object.entries(record.processes)
              .filter(([, entry]) => entry.mutatesFilesystem && !entry.checkpointAfter)
              .map(([id, entry]) => ({ id, command: entry.command, completedAt: entry.completedAt ?? null }))
          }
        });
      }
      return this.recoverActiveCheckpoint(record);
    }
    const diagnosticCode = inspection.diagnostic?.providerCode ?? inspection.diagnostic?.code ?? 'UNKNOWN';
    throw new ForgeError({
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: `Forge could not safely inspect the workspace filesystem after process adoption/reap (${diagnosticCode}).`,
      retryable: true,
      details: { workspaceId: record.workspace.id, inspection: inspection.diagnostic ?? null, recoveryAttempted: true }
    });
  }

  /**
   * Reconcile recorded process entries with the provider. Marks finished
   * processes complete so they stop blocking checkpoints and read paths.
   */
  async syncProcessLifecycle(
    record: WorkspaceRuntimeRecord,
    options: { finalize?: boolean } = {}
  ): Promise<{
    running: number;
    completed: number;
  }> {
    const finalize = options.finalize !== false;
    const handle = await this.providerFor(record).get(record.providerId);
    let running = 0;
    let completed = 0;
    for (const [id, entry] of Object.entries(record.processes)) {
      if (entry.completedAt) {
        completed += 1;
        if (
          finalize &&
          entry.mutatesFilesystem &&
          (entry.exitCode ?? 1) === 0 &&
          !entry.checkpointAfter
        ) {
          await this.finalizeManagedProcess(record, handle, id as ProcessId, {
            id: id as ProcessId,
            providerProcessId: id,
            command: entry.command,
            cwd: '/workspace/repo',
            status: 'exited',
            startedAt: entry.startedAt,
            completedAt: entry.completedAt,
            exitCode: entry.exitCode ?? 0,
            mutatesFilesystem: true
          }).catch(() => undefined);
        }
        continue;
      }
      const { process: live, lookupFailed } = await this.lookupProcessWithRetry(handle, id as ProcessId);
      if (lookupFailed) {
        running += 1;
        continue;
      }
      if (!live) {
        entry.completedAt = new Date().toISOString();
        entry.exitCode = entry.exitCode ?? 1;
        completed += 1;
        continue;
      }
      if (live.status === 'running' || live.status === 'starting') {
        running += 1;
        continue;
      }
      entry.completedAt = live.completedAt ?? new Date().toISOString();
      entry.exitCode = live.exitCode ?? entry.exitCode;
      completed += 1;
      if (finalize && entry.mutatesFilesystem && (entry.exitCode ?? 1) === 0 && !entry.checkpointAfter) {
        await this.finalizeManagedProcess(record, handle, id as ProcessId, live).catch(() => undefined);
      }
    }
    if (finalize && !this.hasUncheckpointedMutators(record)) {
      await this.setWorkspaceKeepAlive(record, false);
    }
    record.workspace.updatedAt = new Date().toISOString();
    return { running, completed };
  }

  private async setWorkspaceKeepAlive(record: WorkspaceRuntimeRecord, keepAlive: boolean): Promise<void> {
    const provider = this.providerFor(record);
    if (!provider.setKeepAlive) return;
    await provider.setKeepAlive(record.providerId, keepAlive).catch(() => undefined);
  }

  /**
   * Confirm the checkout through the same fail-closed recovery path used by
   * every repository operation. A missing mount is restored only from a
   * manifest-backed checkpoint; ambiguous or divergent state is never
   * overwritten.
   */
  async assertCheckoutPresent(record: WorkspaceRuntimeRecord): Promise<void> {
    if (!['ready', 'busy'].includes(record.workspace.state)) return;
    const checkedAt = new Date().toISOString();
    if (record.workspace.activeSnapshotId) {
      await this.handle(record);
      record.workspace.checkout = { healthy: true, checkedAt };
      return;
    }
    const handle = await this.providerFor(record).get(record.providerId);
    const probe = await handle.exec({
      command: 'test -d /workspace/repo/.git && echo forge_checkout_present || echo forge_checkout_missing',
      cwd: '/workspace',
      timeoutMs: 10_000,
      outputLimitBytes: 1_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    if (probe.stdout.includes('forge_checkout_present')) {
      record.workspace.checkout = { healthy: true, checkedAt };
      return;
    }
    record.workspace.state = 'failed';
    record.workspace.checkout = {
      healthy: false,
      checkedAt,
      detail: 'The repository checkout at /workspace/repo is missing.'
    };
    record.workspace.failure = {
      stage: 'checkout',
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: 'The repository checkout is no longer available in the workspace.',
      retryable: false
    };
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = checkedAt;
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: 'The repository checkout is missing; the workspace has been marked failed. Create a new workspace to continue.',
      retryable: false,
      details: { checkout: 'missing' }
    });
  }

  beginMutation(
    record: WorkspaceRuntimeRecord,
    expectedRevision: number | undefined,
    idempotencyKey: string
  ): { operationId: OperationId; replay: boolean; revisionChange?: { from: number; to: number; reason: string; filesystemChanged: boolean; gitChanged: boolean; processStateChanged: boolean } } {
    const prior = record.idempotency[idempotencyKey];
    if (prior) return { operationId: prior.operationId, replay: true };
    const from = record.workspace.revision;
    const operationId = ids.operation();
    record.workspace.revision = nextRevision(record.workspace.revision, expectedRevision);
    record.workspace.updatedAt = new Date().toISOString();
    record.idempotency[idempotencyKey] = {
      operationId,
      revision: record.workspace.revision
    };
    return {
      operationId,
      replay: false,
      revisionChange: {
        from,
        to: record.workspace.revision,
        reason: 'mutation_applied',
        filesystemChanged: false,
        gitChanged: false,
        processStateChanged: false
      }
    };
  }

  async tree(record: WorkspaceRuntimeRecord, input: ListFilesInput) {
    return (await this.handle(record)).listFiles(input);
  }

  async read(record: WorkspaceRuntimeRecord, input: FileReadInput) {
    return (await this.handle(record)).readFile(input);
  }

  async write(
    record: WorkspaceRuntimeRecord,
    input: FileWriteInput,
    expectedRevision: number | undefined,
    idempotencyKey: string
  ) {
    const handle = await this.handle(record);
    const previous = await handle.readFile({ path: input.path, maxBytes: 1_000_000 }).catch(() => undefined);
    if (input.expectedSha256 && previous?.sha256 !== input.expectedSha256) {
      throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: 'The file no longer matches the expected content hash.', retryable: false, details: { path: input.path, expectedSha256: input.expectedSha256, actualSha256: previous?.sha256 } });
    }
    const operation = this.beginMutation(record, expectedRevision, idempotencyKey);
    if (operation.replay) return { replay: true, workspaceId: record.workspace.id, path: input.path, operationId: operation.operationId, filesystemRevision: record.workspace.revision };
    const written = await handle.writeFile(input);
    const observed = await handle.readFile({ path: input.path, maxBytes: new TextEncoder().encode(input.content).byteLength + 1 });
    if (observed.sha256 !== written.sha256 || observed.content !== input.content || observed.truncated) {
      throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: 'Forge could not verify a read-after-write filesystem result.', retryable: false, operationId: operation.operationId, details: { path: input.path, expectedSha256: written.sha256, observedSha256: observed.sha256 } });
    }
    const shellSha256 = await this.shellFileSha256(record, input.path);
    if (shellSha256 !== observed.sha256) {
      throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: 'Forge shell and file APIs did not observe the same written bytes.', retryable: false, operationId: operation.operationId, details: { path: input.path, fileSha256: observed.sha256, shellSha256 } });
    }
    const worktree = await this.gitWorktree(record);
    record.workspace.hasUnpushedWork = true;
    return { workspaceId: record.workspace.id, path: input.path, previousSha256: previous?.sha256 ?? null, resultingSha256: observed.sha256, shellSha256, sizeBytes: observed.sizeBytes, filesystemRevision: record.workspace.revision, gitWorktreeHash: worktree.hash, readAfterWriteVerified: true, operationId: operation.operationId };
  }

  async patch(
    record: WorkspaceRuntimeRecord,
    input: PatchInput,
    expectedRevision: number | undefined,
    idempotencyKey: string
  ) {
    const operation = this.beginMutation(record, expectedRevision, idempotencyKey);
    if (operation.replay) {
      return {
        replay: true,
        operationId: operation.operationId,
        workspaceRevision: record.workspace.revision
      };
    }
    const handle = await this.handle(record);
    const value = await handle.applyPatch(input);
    if (!value.applied) {
      const rejectedFiles = value.rejectedFiles ?? [];
      throw new ForgeError({
        code: 'FORGE_PATCH_REJECTED',
        message: rejectedFiles.length
          ? `The patch did not apply to ${rejectedFiles.join(', ')}. The working tree was left unchanged. Re-read the file (forge_files_read) to get its current content and hash, then retry with a diff built against that content — or use forge_files_write to replace the whole file.`
          : 'The patch could not be applied cleanly. The working tree was left unchanged. Re-read the file (forge_files_read) for its current content, then rebuild the diff — or use forge_files_write to replace the whole file.',
        retryable: false,
        operationId: operation.operationId,
        details: {
          output: value.output.slice(0, 4_000),
          ...(rejectedFiles.length ? { rejectedFiles } : {}),
          rolledBack: value.rolledBack ?? true,
          hint: 'forge_files_write replaces an entire file and avoids diff-context mismatches.'
        }
      });
    }
    // Keep legacy/test provider adapters usable, but never label their result
    // as verified when they do not implement Forge's complete filesystem
    // consistency contract. Production providers implement both methods.
    if (
      typeof (handle as Partial<SandboxHandle>).readFile !== 'function' ||
      typeof (handle as Partial<SandboxHandle>).exec !== 'function'
    ) {
      record.workspace.hasUnpushedWork = true;
      return {
        value,
        workspaceId: record.workspace.id,
        files: [],
        readAfterWriteVerified: false,
        operationId: operation.operationId,
        workspaceRevision: record.workspace.revision
      };
    }
    const files = await Promise.all(value.changedFiles.map(async (path) => {
      const absolutePath = path.startsWith('/workspace/') ? path : `/workspace/repo/${path}`;
      const observed = await handle.readFile({ path: absolutePath, maxBytes: 1_000_000 }).catch(() => undefined);
      if (!observed) {
        const absent = await handle.exec({ command: `test ! -e ${quoted(absolutePath)}`, cwd: '/workspace/repo', timeoutMs: 10_000, outputLimitBytes: 1_000, sessionId: 'system', networkPolicy: 'deny_all' });
        if (absent.exitCode !== 0) throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: 'Forge could not verify a deleted patch path.', retryable: false, operationId: operation.operationId, details: { path: absolutePath } });
        return { path: absolutePath, deleted: true };
      }
      const shellSha256 = await this.shellFileSha256(record, absolutePath);
      if (shellSha256 !== observed.sha256) throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: 'Forge shell and file APIs did not observe the same patched bytes.', retryable: false, operationId: operation.operationId, details: { path: absolutePath, fileSha256: observed.sha256, shellSha256 } });
      return { path: absolutePath, resultingSha256: observed.sha256, shellSha256, sizeBytes: observed.sizeBytes };
    }));
    const worktree = await this.gitWorktree(record);
    record.workspace.hasUnpushedWork = true;
    return {
      value,
      workspaceId: record.workspace.id,
      files,
      gitWorktreeHash: worktree.hash,
      readAfterWriteVerified: true,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision
    };
  }

  async checkpoint(record: WorkspaceRuntimeRecord, name?: string, existingHandle?: SandboxHandle) {
    const handle = existingHandle ?? await this.handle(record);
    const manifest = await this.workspaceManifest(handle);
    const snapshot = await this.providerFor(record).snapshot(record.providerId, {
      name: name ?? `forge-${record.workspace.id}-${record.workspace.revision}`,
      ttlSeconds: 7 * 24 * 60 * 60,
      excludeGitignored: false
    });
    const observedAfterSnapshot = await this.workspaceManifest(handle);
    if (
      observedAfterSnapshot.commit !== manifest.commit ||
      observedAfterSnapshot.branch !== manifest.branch ||
      observedAfterSnapshot.workspaceHashAlgorithm !== manifest.workspaceHashAlgorithm ||
      observedAfterSnapshot.workspaceHash !== manifest.workspaceHash
    ) {
      throw new ForgeError({
        code: 'FORGE_SNAPSHOT_INCOMPATIBLE',
        message: 'Workspace content changed while Forge was creating a checkpoint; the incomplete checkpoint was not accepted.',
        retryable: true,
        details: { workspaceId: record.workspace.id, snapshotId: snapshot.id }
      });
    }
    record.snapshots[snapshot.id] = { ...snapshot, manifest };
    record.workspace.activeSnapshotId = snapshot.id;
    record.workspace.updatedAt = new Date().toISOString();
    return { snapshotId: snapshot.id, createdAt: snapshot.createdAt, providerVersion: snapshot.providerVersion, workspaceRevision: record.workspace.revision };
  }

  async restoreCheckpoint(
    record: WorkspaceRuntimeRecord,
    snapshotId: SnapshotRef['id'],
    expectedRevision?: number,
    cloneSource?: RepositoryCloneSource
  ) {
    const snapshot = record.snapshots[snapshotId];
    if (!snapshot) throw new ForgeError({ code: 'FORGE_SNAPSHOT_INCOMPATIBLE', message: 'The requested workspace checkpoint is unavailable.', retryable: false, details: { snapshotId } });
    const expectedManifest = snapshot.manifest;
    if (!expectedManifest) {
      throw new ForgeError({
        code: 'FORGE_SNAPSHOT_INCOMPATIBLE',
        message: 'Forge refuses an explicit restore from a legacy checkpoint without a pre-capture filesystem manifest.',
        retryable: false,
        details: { snapshotId }
      });
    }
    if (record.workspace.state === 'ready' || record.workspace.state === 'busy') {
      await this.assertDestroySafe(record, cloneSource);
    }
    const rollback = await this.checkpoint(record, `rollback-before-${snapshotId}`);
    const restoreInput = this.restoreInput(record);
    record.workspace.state = 'restoring';
    record.workspace.revision = nextRevision(record.workspace.revision, expectedRevision);
    record.workspace.updatedAt = new Date().toISOString();
    try {
      await this.providerFor(record).destroy(record.providerId);
      const restored = await this.providerFor(record).restore(snapshot, restoreInput);
      const restoredManifest = await this.workspaceManifest(restored);
      if (
        restoredManifest.commit !== expectedManifest.commit ||
        restoredManifest.branch !== expectedManifest.branch ||
        restoredManifest.workspaceHash !== expectedManifest.workspaceHash
      ) {
        throw new ForgeError({
          code: 'FORGE_SNAPSHOT_INCOMPATIBLE',
          message: 'The requested checkpoint filesystem does not match its durable manifest.',
          retryable: false,
          details: { snapshotId }
        });
      }
      // An explicit restore intentionally changes the checkout.  Record that
      // selected checkpoint identity here, rather than treating it as an
      // incidental divergence that a later read might normalize.
      record.workspace.currentCommit = restoredManifest.commit;
      record.workspace.currentBranch = restoredManifest.branch;
      record.lastGitDivergence = undefined;
    } catch (error) {
      const rollbackSnapshot = record.snapshots[rollback.snapshotId]!;
      const rollbackExpectedManifest = rollbackSnapshot.manifest;
      if (!rollbackExpectedManifest) throw error;
      const recovered = await this.providerFor(record).restore(rollbackSnapshot, restoreInput)
        .then(async (rollbackHandle) => {
          const rollbackManifest = await this.workspaceManifest(rollbackHandle);
          if (
            rollbackManifest.commit !== rollbackExpectedManifest.commit ||
            rollbackManifest.branch !== rollbackExpectedManifest.branch ||
            rollbackManifest.workspaceHash !== rollbackExpectedManifest.workspaceHash
          ) return false;
          // A fallback restore is equally explicit: only advertise it as
          // recovered after its exact checkpoint contents have been proven.
          record.workspace.currentCommit = rollbackExpectedManifest.commit;
          record.workspace.currentBranch = rollbackExpectedManifest.branch;
          record.workspace.activeSnapshotId = rollbackSnapshot.id;
          record.lastGitDivergence = undefined;
          return true;
        })
        .catch(() => false);
      record.workspace.state = recovered ? 'ready' : 'failed';
      record.workspace.updatedAt = new Date().toISOString();
      throw new ForgeError({ code: 'FORGE_SNAPSHOT_INCOMPATIBLE', message: recovered ? 'Forge could not restore the requested checkpoint; the previous workspace snapshot was recovered.' : 'Forge could not restore the requested checkpoint or recover the previous workspace snapshot.', retryable: recovered, details: { snapshotId, rollbackSnapshotId: rollback.snapshotId, recovered, cause: error instanceof Error ? error.message : String(error) } });
    }
    record.processes = {};
    record.previews = {};
    record.workspace.activeSnapshotId = snapshotId;
    record.workspace.state = 'ready';
    await this.reconcileGitState(record);
    return { workspaceId: record.workspace.id, restoredSnapshotId: snapshotId, workspaceRevision: record.workspace.revision, branch: record.workspace.currentBranch, commit: record.workspace.currentCommit };
  }

  async exec(
    record: WorkspaceRuntimeRecord,
    input: Omit<ExecInput, 'sessionId'> & {
      sessionId?: string;
      approved?: boolean;
      idempotencyKey?: string;
      expectedRevision?: number;
    }
  ) {
    const decision = assertCommandAllowed(
      input.command,
      input.networkPolicy,
      input.approved ?? false
    );
    const mutates = decision.classification !== 'read_only';
    let operationId: OperationId | undefined;
    if (mutates) {
      if (!input.idempotencyKey) {
        throw new ForgeError({
          code: 'FORGE_VALIDATION_FAILED',
          message: 'Mutating shell commands require an idempotency key.',
          retryable: false
        });
      }
      const operation = this.beginMutation(
        record,
        input.expectedRevision,
        input.idempotencyKey
      );
      operationId = operation.operationId;
      if (operation.replay) {
        const processId = record.idempotency[input.idempotencyKey!]?.processId;
        if (processId && record.processes[processId]) {
          const entry = record.processes[processId]!;
          const status = managedProcessStatus(entry);
          return {
            // Never claim exitCode 0 for an unknown/replayed shell outcome — that
            // is how ChatGPT gets stuck treating a timed-out install as success.
            status: entry.completedAt ? 'completed' : 'started',
            ...(entry.completedAt ? { exitCode: entry.exitCode ?? 1 } : {}),
            stdout: '',
            stderr: entry.completedAt
              ? `Replayed idempotency key; managed process ${processId} finished with exit ${entry.exitCode ?? 1}.`
              : `Replayed idempotency key; managed process ${processId} is still running. Call forge_process_wait.`,
            truncated: false,
            durationMs: 0,
            artifactRefs: [],
            replay: true,
            replayed: true,
            idempotencyKey: input.idempotencyKey,
            originalOperationId: operation.operationId,
            workspaceId: record.workspace.id,
            branch: record.workspace.currentBranch,
            head: record.workspace.currentCommit,
            classification: decision.classification,
            operationId,
            workspaceRevision: record.workspace.revision,
            managedProcess: {
              processId,
              status,
              startedAt: entry.startedAt,
              command: entry.command,
              ...(entry.completedAt ? { completedAt: entry.completedAt, exitCode: entry.exitCode } : {})
            },
            next_step: entry.completedAt
              ? `Managed process ${processId} already finished with exit ${entry.exitCode ?? 1}.`
              : `Call forge_process_wait with process_id ${processId} (use timeout_ms >= 600000 for large installs).`,
            allowedNextActions: entry.completedAt
              ? ['forge_process_list', 'forge_shell', 'forge_workspace_get']
              : ['forge_process_wait', 'forge_process_logs', 'forge_process_list']
          };
        }
        return {
          status: 'replayed_unknown',
          exitCode: 125,
          stdout: '',
          stderr: 'Replayed idempotency key, but Forge did not persist a verified command outcome. Inspect forge_operation_get / forge_process_list before retrying with a new key.',
          truncated: false,
          durationMs: 0,
          artifactRefs: [],
          replay: true,
          replayed: true,
          idempotencyKey: input.idempotencyKey,
          originalOperationId: operation.operationId,
          workspaceId: record.workspace.id,
          branch: record.workspace.currentBranch,
          head: record.workspace.currentCommit,
          classification: decision.classification,
          operationId,
          workspaceRevision: record.workspace.revision,
          allowedNextActions: ['forge_operation_get', 'forge_process_list', 'forge_workspace_get']
        };
      }
    }
    const handle = await this.handle(record);
    const result = await handle.exec({
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      environment: nonInteractiveShellEnv(input.environment ?? {}),
      stdin: input.stdin,
      outputLimitBytes: input.outputLimitBytes,
      sessionId: input.sessionId ?? 'agent-default',
      networkPolicy: input.networkPolicy
    });
    return {
      ...result,
      workspaceId: record.workspace.id,
      branch: record.workspace.currentBranch,
      head: record.workspace.currentCommit,
      baseCommit: record.workspace.baseCommit,
      classification: decision.classification,
      operationId,
      ...(operationId && input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey, replayed: false, originalOperationId: operationId }
        : {}),
      workspaceRevision: record.workspace.revision
    };
  }

  async startProcess(
    record: WorkspaceRuntimeRecord,
    input: {
      command: string;
      cwd: string;
      environment?: Record<string, string>;
      networkPolicy: NetworkPolicyMode;
      idempotencyKey: string;
      expectedRevision?: number;
      approved?: boolean;
    }
  ) {
    const decision = classifyCommand(input.command, input.networkPolicy);
    // Approved dependency installs must be allowed as managed processes. Blocking
    // them forced the timeout-conversion path, which restarted installs and left
    // a torn node_modules tree invisible to later shells.
    assertCommandAllowed(input.command, input.networkPolicy, input.approved ?? false);
    const operation = this.beginMutation(
      record,
      input.expectedRevision,
      input.idempotencyKey
    );
    if (operation.replay) {
      const replayed = this.replayManagedProcess(record, input.idempotencyKey, input.cwd, operation.operationId);
      if (replayed) return replayed;
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_CONFLICT',
        message: 'This process start was already accepted but its process id is no longer available; inspect forge_workspace_get and forge_process_list before retrying with a new idempotency key.',
        retryable: false,
        details: {
          idempotencyKey: input.idempotencyKey,
          operationId: operation.operationId,
          allowedNextActions: ['forge_workspace_get', 'forge_process_list', 'forge_operation_get']
        }
      });
    }
    const processId = ids.process();
    const startedAt = new Date().toISOString();
    const mutatesFilesystem = decision.classification !== 'read_only';
    // Keep the container awake for the whole mutation. Cloudflare sleep wipes
    // /workspace; without keepAlive a finished install can vanish before the
    // next shell command or post-process checkpoint.
    if (mutatesFilesystem) await this.setWorkspaceKeepAlive(record, true);
    const value = await (await this.handle(record, { allowRestore: !mutatesFilesystem })).startProcess({
      processId,
      command: input.command,
      cwd: input.cwd,
      environment: nonInteractiveShellEnv(input.environment ?? {}),
      // Same session as forge_shell so later foreground commands share the
      // shell environment and always observe the process filesystem writes.
      sessionId: 'agent-default',
      networkPolicy: input.networkPolicy,
      autoCleanup: false,
      mutatesFilesystem
    });
    record.processes[processId] = {
      command: input.command,
      startedAt,
      mutatesFilesystem
    };
    record.idempotency[input.idempotencyKey] = {
      ...record.idempotency[input.idempotencyKey]!,
      processId
    };
    return {
      value: { ...value, mutatesFilesystem },
      replayed: false,
      idempotencyKey: input.idempotencyKey,
      originalOperationId: operation.operationId,
      workspaceId: record.workspace.id,
      branch: record.workspace.currentBranch,
      head: record.workspace.currentCommit,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: ['forge_process_wait', 'forge_process_logs', 'forge_process_list']
    };
  }

  private replayManagedProcess(
    record: WorkspaceRuntimeRecord,
    idempotencyKey: string,
    cwd: string,
    operationId: OperationId
  ) {
    const processId = record.idempotency[idempotencyKey]?.processId;
    if (!processId) return null;
    const entry = record.processes[processId];
    if (!entry) return null;
    const status = managedProcessStatus(entry);
    return {
      replay: true as const,
      replayed: true as const,
      idempotencyKey,
      originalOperationId: operationId,
      value: {
        id: processId,
        providerProcessId: processId,
        command: entry.command,
        cwd,
        status,
        startedAt: entry.startedAt,
        mutatesFilesystem: entry.mutatesFilesystem,
        ...(entry.completedAt ? { completedAt: entry.completedAt, exitCode: entry.exitCode ?? 1 } : {})
      },
      workspaceId: record.workspace.id,
      branch: record.workspace.currentBranch,
      head: record.workspace.currentCommit,
      operationId,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: entry.completedAt
        ? ['forge_process_list', 'forge_process_logs', 'forge_shell']
        : ['forge_process_wait', 'forge_process_logs', 'forge_process_list']
    };
  }

  async processLogs(
    record: WorkspaceRuntimeRecord,
    processId: ProcessId,
    cursor?: string
  ) {
    const handle = await this.handle(record, { allowRestore: false });
    const logs = await handle.readProcessLogs({
      processId,
      cursor,
      limitBytes: 200_000
    });
    const process = await handle.getProcess(processId);
    const entry = record.processes[processId];
    if (entry && process && !entry.completedAt && process.status !== 'running' && process.status !== 'starting') {
      entry.completedAt = process.completedAt ?? new Date().toISOString();
      entry.exitCode = process.exitCode ?? entry.exitCode;
      record.workspace.updatedAt = new Date().toISOString();
    }
    const status = process?.status
      ?? (entry ? managedProcessStatus(entry) : 'orphaned');
    const hasMore = Boolean(logs.nextCursor);
    return {
      data: logs.data,
      nextCursor: logs.nextCursor ?? null,
      hasMore,
      truncated: logs.truncated,
      status,
      exitCode: process?.exitCode ?? entry?.exitCode,
      completedAt: process?.completedAt ?? entry?.completedAt ?? null,
      mutatesFilesystem: entry?.mutatesFilesystem ?? process?.mutatesFilesystem ?? false,
      filesystemCommitted: Boolean(entry?.checkpointAfter),
      workspaceRevision: record.workspace.revision,
      allowedNextActions: status === 'running' || status === 'starting'
        ? ['forge_process_wait', 'forge_process_logs', 'forge_process_list']
        : ['forge_process_list', 'forge_shell', 'forge_workspace_get']
    };
  }

  async processGet(record: WorkspaceRuntimeRecord, processId: ProcessId) {
    const handle = await this.handle(record, { allowRestore: false });
    const process = await handle.getProcess(processId);
    if (!process) throw new ForgeError({ code: 'FORGE_PROCESS_NOT_FOUND', message: 'The managed process was not found in this workspace.', retryable: false, details: { processId } });
    const entry = record.processes[processId];
    if (entry && !entry.completedAt && process.status !== 'running' && process.status !== 'starting') {
      entry.completedAt = process.completedAt ?? new Date().toISOString();
      entry.exitCode = process.exitCode ?? entry.exitCode;
      record.workspace.updatedAt = new Date().toISOString();
    }
    const merged = {
      ...process,
      command: entry?.command || process.command,
      mutatesFilesystem: entry?.mutatesFilesystem ?? process.mutatesFilesystem,
      checkpointAfter: entry?.checkpointAfter,
      ...(entry?.completedAt
        ? { completedAt: entry.completedAt, exitCode: entry.exitCode ?? process.exitCode }
        : {})
    };
    return {
      workspaceId: record.workspace.id,
      process: merged,
      recorded: entry ?? null,
      dependencyState: dependencyStateView(record.dependencyState),
      workspaceRevision: record.workspace.revision,
      allowedNextActions: merged.status === 'running' || merged.status === 'starting'
        ? ['forge_process_wait', 'forge_process_logs', 'forge_process_stop']
        : ['forge_shell', 'forge_workspace_get']
    };
  }

  async processList(record: WorkspaceRuntimeRecord) {
    await this.syncProcessLifecycle(record);
    const processes = Object.entries(record.processes).map(([id, entry]) => ({
      id,
      command: entry.command,
      status: managedProcessStatus(entry),
      exitCode: entry.exitCode,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      mutatesFilesystem: entry.mutatesFilesystem,
      checkpointAfter: entry.checkpointAfter,
      filesystemCommitted: Boolean(entry.checkpointAfter)
    }));
    return {
      workspaceId: record.workspace.id,
      processes,
      dependencyState: dependencyStateView(record.dependencyState),
      workspaceRevision: record.workspace.revision,
      allowedNextActions: workspaceAllowedNextActions(record)
    };
  }

  async operationGet(record: WorkspaceRuntimeRecord, operationId: OperationId) {
    // Sync provider process status before reporting, so a completed install is
    // not still described as active after a client disconnect.
    await this.syncProcessLifecycle(record).catch(() => undefined);
    const match = Object.entries(record.idempotency).find(([, value]) => value.operationId === operationId);
    if (!match) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: 'No operation with that id is recorded for this workspace.',
        retryable: false,
        details: { operationId, allowedNextActions: ['forge_workspace_get', 'forge_process_list'] }
      });
    }
    const [idempotencyKey, entry] = match;
    const processId = entry.processId;
    const processEntry = processId ? record.processes[processId] : undefined;
    let status: 'accepted' | 'active' | 'completed' | 'failed' | 'cancelled' = 'accepted';
    if (processEntry) {
      const processStatus = managedProcessStatus(processEntry);
      status = processStatus === 'running'
        ? 'active'
        : processStatus === 'exited'
          ? 'completed'
          : processStatus === 'cancelled'
            ? 'cancelled'
            : 'failed';
    }
    return {
      workspaceId: record.workspace.id,
      operationId,
      idempotencyKey,
      replayed: false,
      originalOperationId: operationId,
      status,
      processId: processId ?? null,
      process: processEntry
        ? {
            id: processId,
            command: processEntry.command,
            status: managedProcessStatus(processEntry),
            exitCode: processEntry.exitCode,
            completedAt: processEntry.completedAt,
            mutatesFilesystem: processEntry.mutatesFilesystem,
            filesystemCommitted: Boolean(processEntry.checkpointAfter)
          }
        : null,
      dependencyState: dependencyStateView(record.dependencyState),
      workspaceRevision: record.workspace.revision,
      allowedNextActions: status === 'active'
        ? ['forge_process_wait', 'forge_process_list', 'forge_process_logs']
        : ['forge_workspace_get', 'forge_process_list', 'forge_shell']
    };
  }

  async processWait(record: WorkspaceRuntimeRecord, processId: ProcessId, timeoutMs?: number) {
    // Never restore a checkpoint while waiting — that would discard the process
    // filesystem writes that this wait is supposed to publish.
    const handle = await this.handle(record, { allowRestore: false });
    const requestedTimeoutMs = timeoutMs ?? 120_000;
    let process: ProcessRecord;
    try {
      if (handle.processWait) {
        process = await handle.processWait({ processId, timeoutMs: requestedTimeoutMs });
      } else {
        const current = await handle.getProcess(processId);
        if (!current) throw new ForgeError({ code: 'FORGE_PROCESS_NOT_FOUND', message: 'The managed process was not found in this workspace.', retryable: false, details: { processId } });
        process = current;
      }
    } catch (error) {
      if (
        error instanceof ForgeError &&
        error.code === 'FORGE_COMMAND_TIMEOUT'
      ) {
        return this.processWaitTimedOut(record, handle, processId, requestedTimeoutMs);
      }
      throw error;
    }
    if (process.status === 'running' || process.status === 'starting') {
      // Provider returned a non-terminal snapshot without throwing — treat as
      // observational timeout so ChatGPT gets a steered next action.
      return this.processWaitTimedOut(record, handle, processId, requestedTimeoutMs, process);
    }
    await this.finalizeManagedProcess(record, handle, processId, process);
    if (!this.hasUncheckpointedMutators(record)) {
      await this.setWorkspaceKeepAlive(record, false);
    }
    const entry = record.processes[processId];
    return {
      timedOut: false as const,
      workspaceId: record.workspace.id,
      process: {
        ...process,
        mutatesFilesystem: entry?.mutatesFilesystem ?? process.mutatesFilesystem,
        checkpointAfter: entry?.checkpointAfter,
        ...(entry?.completedAt
          ? { completedAt: entry.completedAt, exitCode: entry.exitCode }
          : {})
      },
      dependencyState: dependencyStateView(record.dependencyState),
      filesystemCommitted: Boolean(entry?.checkpointAfter),
      finalLogCursor: null,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: ['forge_shell', 'forge_workspace_get', 'forge_process_logs'],
      next_step: 'Process finished. Continue with shell commands or forge_workspace_get.'
    };
  }

  private async processWaitTimedOut(
    record: WorkspaceRuntimeRecord,
    handle: SandboxHandle,
    processId: ProcessId,
    timeoutMs: number,
    known?: ProcessRecord | null
  ) {
    const process = known ?? await handle.getProcess(processId).catch(() => null);
    const entry = record.processes[processId];
    const suggestedTimeoutMs = Math.min(600_000, Math.max(timeoutMs * 2, 300_000));
    return {
      timedOut: true as const,
      workspaceId: record.workspace.id,
      process: {
        id: processId,
        providerProcessId: process?.providerProcessId ?? processId,
        command: entry?.command ?? process?.command ?? '',
        cwd: process?.cwd ?? '/workspace/repo',
        status: (process?.status ?? (entry && !entry.completedAt ? 'running' : 'orphaned')) as ProcessRecord['status'],
        pid: process?.pid,
        startedAt: entry?.startedAt ?? process?.startedAt ?? new Date().toISOString(),
        mutatesFilesystem: entry?.mutatesFilesystem ?? process?.mutatesFilesystem ?? false,
        ...(entry?.completedAt
          ? { completedAt: entry.completedAt, exitCode: entry.exitCode }
          : {})
      },
      dependencyState: dependencyStateView(record.dependencyState),
      filesystemCommitted: Boolean(entry?.checkpointAfter),
      finalLogCursor: null,
      suggestedTimeoutMs,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: ['forge_process_wait', 'forge_process_logs', 'forge_process_list'],
      next_step: `Process ${processId} is still running after ${timeoutMs}ms. Retry forge_process_wait with timeout_ms >= ${suggestedTimeoutMs} (use 600000 for large installs). Do not restart the install.`
    };
  }

  async processCancel(
    record: WorkspaceRuntimeRecord,
    processId: ProcessId,
    expectedRevision: number | undefined,
    idempotencyKey: string
  ) {
    if (!record.processes[processId]) {
      throw new ForgeError({
        code: 'FORGE_PROCESS_NOT_FOUND',
        message: 'The process is not owned by this workspace.',
        retryable: false,
        details: { processId }
      });
    }
    const operation = this.beginMutation(record, expectedRevision, idempotencyKey);
    if (operation.replay) {
      return {
        replay: true,
        replayed: true,
        idempotencyKey,
        originalOperationId: operation.operationId,
        workspaceId: record.workspace.id,
        processId,
        operationId: operation.operationId,
        workspaceRevision: record.workspace.revision,
        allowedNextActions: ['forge_process_list', 'forge_workspace_get']
      };
    }
    const handle = await this.handle(record);
    let process: { status: string; exitCode?: number; completedAt?: string };
    if (handle.processCancel) {
      const result = await handle.processCancel(processId);
      process = result;
    } else {
      await handle.stopProcess(processId);
      process = { status: 'cancelled', exitCode: 124, completedAt: new Date().toISOString() };
    }
    const entry = record.processes[processId];
    if (entry) {
      entry.completedAt = process.completedAt;
      entry.exitCode = process.exitCode;
    }
    delete record.processes[processId];
    delete record.checks[processId];
    return {
      workspaceId: record.workspace.id,
      processId,
      cancelled: true,
      replayed: false,
      idempotencyKey,
      originalOperationId: operation.operationId,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: ['forge_process_list', 'forge_workspace_get', 'forge_shell']
    };
  }

  async stopProcess(
    record: WorkspaceRuntimeRecord,
    processId: ProcessId,
    expectedRevision: number | undefined,
    idempotencyKey: string
  ) {
    if (!record.processes[processId]) {
      throw new ForgeError({
        code: 'FORGE_PROCESS_NOT_FOUND',
        message: 'The process is not owned by this workspace.',
        retryable: false,
        details: { processId }
      });
    }
    const operation = this.beginMutation(record, expectedRevision, idempotencyKey);
    if (operation.replay) {
      return {
        replay: true,
        replayed: true,
        idempotencyKey,
        originalOperationId: operation.operationId,
        workspaceId: record.workspace.id,
        processId,
        operationId: operation.operationId,
        workspaceRevision: record.workspace.revision,
        allowedNextActions: ['forge_process_list', 'forge_workspace_get']
      };
    }
    await (await this.handle(record)).stopProcess(processId);
    const entry = record.processes[processId];
    if (entry) {
      entry.completedAt = new Date().toISOString();
      entry.exitCode = 0;
    }
    const check = record.checks[processId] ?? null;
    delete record.processes[processId];
    delete record.checks[processId];
    return {
      workspaceId: record.workspace.id,
      processId,
      stopped: true,
      check,
      replayed: false,
      idempotencyKey,
      originalOperationId: operation.operationId,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: ['forge_process_list', 'forge_workspace_get', 'forge_shell']
    };
  }

  async startCheck(
    record: WorkspaceRuntimeRecord,
    input: {
      name: string;
      command: string;
      cwd: string;
      environment?: Record<string, string>;
      networkPolicy: NetworkPolicyMode;
      idempotencyKey: string;
      expectedRevision?: number;
    }
  ) {
    if (!input.name.trim() || input.name.length > 100) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Check name is invalid.', retryable: false });
    const started = await this.startProcess(record, input);
    if ('replay' in started) return started;
    const processId = started.value.id;
    record.checks[processId] = {
      name: input.name.trim(),
      command: input.command,
      startedAt: new Date().toISOString(),
      workspaceRevision: record.workspace.revision,
      ...(record.workspace.currentCommit ? { commit: record.workspace.currentCommit } : {})
    };
    return { ...started, check: { processId, ...record.checks[processId] } };
  }

  async checkGet(record: WorkspaceRuntimeRecord, processId: ProcessId) {
    const value = await this.processGet(record, processId);
    return { ...value, check: record.checks[processId] ?? null };
  }

  async reconcileGitState(record: WorkspaceRuntimeRecord): Promise<boolean> {
    const handle = await this.providerFor(record).get(record.providerId);
    let inspection = await this.inspectWorkspace(handle, record);
    if (inspection.state === 'unavailable') {
      inspection = await this.recoverUnavailableInspection(record, handle, inspection);
    }
    if (inspection.state === 'mount_missing') {
      if (this.hasUncheckpointedMutators(record)) {
        throw new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'Workspace mount is missing, but Forge will not restore a checkpoint while managed mutating processes still have uncheckpointed filesystem writes.',
          retryable: true,
          details: { workspaceId: record.workspace.id }
        });
      }
      await this.recoverActiveCheckpoint(record);
      return true;
    }
    if (inspection.state === 'diverged') {
      this.noteGitDivergence(record, inspection);
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED',
        message: 'The workspace filesystem Git state differs from Forge metadata; Forge will not normalize it automatically.',
        retryable: false,
        details: { workspaceId: record.workspace.id, recorded: { commit: record.workspace.currentCommit ?? null, branch: record.workspace.currentBranch ?? null }, observed: { commit: inspection.commit ?? null, branch: inspection.branch ?? null } }
      });
    }
    if (inspection.state === 'unavailable') {
      const diagnosticCode = inspection.diagnostic?.providerCode ?? inspection.diagnostic?.code ?? 'UNKNOWN';
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: `Forge could not safely inspect the workspace Git state after process adoption/reap (${diagnosticCode}).`,
        retryable: true,
        details: { workspaceId: record.workspace.id, inspection: inspection.diagnostic ?? null, recoveryAttempted: true }
      });
    }
    return false;
  }

  /**
   * After a Durable Object or sandbox blip, tracked processes may be live,
   * exited, or gone. Adopt terminal ones, leave live ones blocking, and retry
   * filesystem inspection instead of returning opaque UNKNOWN.
   */
  private async recoverUnavailableInspection(
    record: WorkspaceRuntimeRecord,
    handle: SandboxHandle,
    previous: {
      state: 'matches' | 'mount_missing' | 'diverged' | 'unavailable';
      commit?: string;
      branch?: string;
      diagnostic?: { code: string; providerCode?: string; operation?: string };
    }
  ): Promise<{
    state: 'matches' | 'mount_missing' | 'diverged' | 'unavailable';
    commit?: string;
    branch?: string;
    diagnostic?: { code: string; providerCode?: string; operation?: string };
  }> {
    await this.adoptOrReapProcesses(record, handle);
    // Give the provider a brief moment after DO/storage churn before re-probing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const retry = await this.inspectWorkspace(handle, record);
    if (retry.state !== 'unavailable') return retry;
    return {
      ...retry,
      diagnostic: retry.diagnostic ?? previous.diagnostic ?? { code: 'UNKNOWN', operation: 'recover_unavailable_inspection' }
    };
  }

  private async lookupProcessWithRetry(
    handle: SandboxHandle,
    processId: ProcessId
  ): Promise<{ process: ProcessRecord | null; lookupFailed: boolean }> {
    let lookupFailed = false;
    let process: ProcessRecord | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        process = await handle.getProcess(processId);
        lookupFailed = false;
        if (process) return { process, lookupFailed };
      } catch {
        lookupFailed = true;
        process = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { process, lookupFailed };
  }

  private async adoptOrReapProcesses(record: WorkspaceRuntimeRecord, handle: SandboxHandle): Promise<void> {
    for (const [id, entry] of Object.entries(record.processes)) {
      if (entry.completedAt && entry.checkpointAfter) continue;
      const { process: live, lookupFailed } = await this.lookupProcessWithRetry(handle, id as ProcessId);
      if (lookupFailed) {
        // Provider blip — keep the process live so checkpoints stay blocked.
        continue;
      }
      if (!live) {
        // Confirmed missing after retries. Adopt as exited, but do not pretend
        // a successful mutating install completed.
        if (!entry.completedAt) {
          entry.completedAt = new Date().toISOString();
          entry.exitCode = entry.exitCode ?? 1;
        }
        continue;
      }
      if (live.status === 'running' || live.status === 'starting') continue;
      entry.completedAt = live.completedAt ?? entry.completedAt ?? new Date().toISOString();
      entry.exitCode = live.exitCode ?? entry.exitCode;
      if (record.checks[id]) {
        record.checks[id] = {
          ...record.checks[id]!,
          completedAt: entry.completedAt,
          exitCode: entry.exitCode
        };
      }
      if (entry.mutatesFilesystem && (entry.exitCode ?? 1) === 0 && !entry.checkpointAfter) {
        await this.finalizeManagedProcess(record, handle, id as ProcessId, live).catch(() => undefined);
      }
    }
    record.workspace.updatedAt = new Date().toISOString();
  }

  /**
   * After a managed process exits, make its filesystem effects durable and
   * visible to subsequent shell commands on the shared agent session.
   */
  private async finalizeManagedProcess(
    record: WorkspaceRuntimeRecord,
    handle: SandboxHandle,
    processId: ProcessId,
    process: ProcessRecord
  ): Promise<void> {
    const entry = record.processes[processId];
    if (!entry) return;
    const terminal = process.status !== 'running' && process.status !== 'starting';
    if (!terminal) return;
    if (!entry.completedAt) {
      entry.completedAt = process.completedAt ?? new Date().toISOString();
      entry.exitCode = process.exitCode ?? entry.exitCode;
    }
    if (record.checks[processId]) {
      record.checks[processId] = {
        ...record.checks[processId]!,
        completedAt: entry.completedAt,
        exitCode: entry.exitCode
      };
    }
    if (!entry.mutatesFilesystem || (entry.exitCode ?? process.exitCode ?? 1) !== 0) {
      record.workspace.updatedAt = new Date().toISOString();
      return;
    }
    // Idempotent: a prior successful finalize already proved visibility and
    // captured a checkpoint for this process.
    if (entry.checkpointAfter && record.dependencyState?.usable !== false) {
      record.workspace.updatedAt = new Date().toISOString();
      return;
    }

    const decision = classifyCommand(entry.command, 'package_install');
    const isNodeInstall = decision.classification === 'dependency_install'
      && /(^|\s)(npm|pnpm|yarn|bun)\s+/i.test(entry.command);
    const isPythonInstall = decision.classification === 'dependency_install'
      && /(^|\s)(pip|uv)\s+install(\s|$)/i.test(entry.command);

    // Flush and prove the install/mutation is visible through the same session
    // foreground shells use (`agent-default`), before we publish success.
    const visibility = await handle.exec({
      command: [
        'sync',
        'if [ -d node_modules ] || [ -f .pnp.cjs ] || [ -f .pnp.js ]; then echo "FORGE_NODE_MODULES=present"; else echo "FORGE_NODE_MODULES=absent"; fi',
        'if [ -d .venv ] || [ -d venv ] || ls -d site-packages >/dev/null 2>&1; then echo "FORGE_PYTHON_ENV=present"; else echo "FORGE_PYTHON_ENV=absent"; fi',
        'if [ -f pnpm-lock.yaml ] || [ -f package-lock.json ] || [ -f yarn.lock ] || [ -f bun.lock ] || [ -f requirements.txt ] || [ -f uv.lock ]; then echo "FORGE_LOCKFILE=present"; fi'
      ].join('; '),
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
      outputLimitBytes: 4_000,
      sessionId: 'agent-default',
      networkPolicy: 'deny_all'
    }).catch(() => null);

    if (decision.classification === 'dependency_install') {
      let usable = Boolean(visibility && visibility.exitCode === 0);
      if (isNodeInstall) {
        usable = Boolean(
          visibility &&
          visibility.exitCode === 0 &&
          visibility.stdout.includes('FORGE_NODE_MODULES=present')
        );
      } else if (isPythonInstall) {
        // Python installs do not create node_modules; trust a successful sync
        // plus either a virtualenv marker or lock/requirements presence.
        usable = Boolean(
          visibility &&
          visibility.exitCode === 0 &&
          (
            visibility.stdout.includes('FORGE_PYTHON_ENV=present') ||
            visibility.stdout.includes('FORGE_LOCKFILE=present')
          )
        );
      }
      const lockfileHash = await handle.exec({
        command: 'sha256sum pnpm-lock.yaml package-lock.json yarn.lock bun.lock uv.lock requirements.txt 2>/dev/null | head -1 | cut -d" " -f1 || echo none',
        cwd: '/workspace/repo',
        timeoutMs: 10_000,
        outputLimitBytes: 1_000,
        sessionId: 'agent-default',
        networkPolicy: 'deny_all'
      }).then((result) => result.stdout.trim() || 'none').catch(() => 'none');
      record.dependencyState = {
        lockfileHash,
        installedAt: entry.completedAt,
        usable
      };
      if (!usable) {
        record.workspace.updatedAt = new Date().toISOString();
        throw new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'Managed dependency install exited successfully but the installed package tree is not visible to the workspace shell.',
          retryable: true,
          details: {
            processId,
            visibility: visibility
              ? { exitCode: visibility.exitCode, stdout: visibility.stdout.slice(0, 1_000), stderr: visibility.stderr.slice(0, 1_000) }
              : null
          }
        });
      }
    }

    if (!entry.checkpointAfter) {
      try {
        const checkpoint = await this.checkpoint(record, `process-${processId}`, handle);
        entry.checkpointAfter = checkpoint.snapshotId as SnapshotId;
      } catch {
        // Non-fatal: the process succeeded; recovery may need a later checkpoint.
      }
    }
    record.workspace.updatedAt = new Date().toISOString();
  }

  /**
   * Safe workspace reconciliation. Unlike reconcileGitState (which throws on
   * divergence), this method returns a detailed report describing the Git
   * integrity state and recommended action, without throwing.
   *
   * It:
   * 1. Stops or adopts unknown workspace processes.
   * 2. Checks for Git lock files.
   * 3. Verifies .git/HEAD.
   * 4. Verifies index readability.
   * 5. Verifies the working tree.
   * 6. Compares current HEAD with the recorded head.
   * 7. Compares the branch with the recorded branch.
   * 8. Detects ongoing package-manager file activity.
   * 9. Restores the latest checkpoint only when necessary.
   * 10. Preserves a patch of tracked working-tree changes before destructive recovery.
   *
   * Returns a detailed reconciliation report with gitIntegrity state, reason,
   * and recommended_action.
   */
  async reconcileWorkspace(record: WorkspaceRuntimeRecord): Promise<{
    workspaceId: string;
    gitIntegrity: {
      state: 'consistent' | 'unknown' | 'diverged' | 'corrupted';
      reason: string;
      blockingProcessId?: string;
      gitHeadReadable: boolean;
      gitIndexReadable: boolean;
      workingTreeReadable: boolean;
      recommendedAction: string;
      destructiveRecoveryRequired: boolean;
    };
    processes: Array<{ id: string; command: string; status: string; exitCode?: number }>;
    dependencyState: DependencyStateView;
    trackedChangesPreserved: boolean;
    checkpointRestored: boolean;
    workspaceRevision: number;
    allowedNextActions: string[];
  }> {
    const handle = await this.providerFor(record).get(record.providerId);
    const now = new Date().toISOString();

    // 1. Stop or adopt unknown workspace processes.
    const activeProcesses = Object.entries(record.processes);
    const processReport: Array<{ id: string; command: string; status: string; exitCode?: number }> = [];
    for (const [id, entry] of activeProcesses) {
      const { process: live, lookupFailed } = await this.lookupProcessWithRetry(handle, id as ProcessId);
      if (lookupFailed) {
        // Provider blip — keep the tracked process and report uncertainty.
        processReport.push({ id, command: entry.command, status: entry.completedAt ? 'exited' : 'unknown', exitCode: entry.exitCode });
        continue;
      }
      if (live) {
        processReport.push({ id, command: entry.command, status: live.status, exitCode: live.exitCode });
        if (live.status === 'running' || live.status === 'starting') continue;
        if (!entry.completedAt) {
          entry.completedAt = live.completedAt ?? new Date().toISOString();
          entry.exitCode = live.exitCode ?? entry.exitCode;
        }
        if (entry.mutatesFilesystem && (entry.exitCode ?? 1) === 0 && !entry.checkpointAfter) {
          await this.finalizeManagedProcess(record, handle, id as ProcessId, live).catch(() => undefined);
        }
        continue;
      }
      // Confirmed missing after retries.
      if (entry.completedAt) {
        processReport.push({ id, command: entry.command, status: 'exited', exitCode: entry.exitCode });
      } else {
        // Orphaned: was tracked but no longer exists. Clean up.
        delete record.processes[id];
        delete record.checks[id];
        processReport.push({ id, command: entry.command, status: 'orphaned' });
      }
    }

    // 2. Check for Git lock files.
    const lockCheck = await handle.exec({
      command: 'test -f .git/index.lock -o -f .git/HEAD.lock -o -f .git/config.lock; echo $?',
      cwd: '/workspace/repo',
      timeoutMs: 10_000,
      outputLimitBytes: 1_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch(() => ({ exitCode: 0, stdout: '1', stderr: '', truncated: false, durationMs: 0, artifactRefs: [] }));
    const hasGitLock = lockCheck.stdout.trim() === '0';

    // 3. Verify .git/HEAD.
    const headCheck = await handle.exec({
      command: 'test -f .git/HEAD && cat .git/HEAD || echo "NO_HEAD"',
      cwd: '/workspace/repo',
      timeoutMs: 10_000,
      outputLimitBytes: 1_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch(() => ({ exitCode: 1, stdout: 'NO_HEAD', stderr: '', truncated: false, durationMs: 0, artifactRefs: [] }));
    const gitHeadReadable = headCheck.exitCode === 0 && !headCheck.stdout.includes('NO_HEAD');

    // 4. Verify index readability.
    const indexCheck = await handle.exec({
      command: 'git ls-files --error-unmatch . 2>&1 | head -1; echo "EXIT:$?"',
      cwd: '/workspace/repo',
      timeoutMs: 10_000,
      outputLimitBytes: 10_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch(() => ({ exitCode: 1, stdout: '', stderr: 'index unreadable', truncated: false, durationMs: 0, artifactRefs: [] }));
    const gitIndexReadable = indexCheck.exitCode === 0 || indexCheck.stdout.includes('EXIT:0');

    // 5. Verify the working tree.
    const treeCheck = await handle.exec({
      command: 'git status --porcelain=v2 --branch 2>&1 | head -5; echo "EXIT:$?"',
      cwd: '/workspace/repo',
      timeoutMs: 15_000,
      outputLimitBytes: 10_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch(() => ({ exitCode: 1, stdout: '', stderr: 'working tree unreadable', truncated: false, durationMs: 0, artifactRefs: [] }));
    const workingTreeReadable = treeCheck.exitCode === 0;

    // 6. Compare current HEAD with the recorded head.
    const identity = await this.gitIdentity(handle).catch(() => null);
    const headMatches = identity?.commit === record.workspace.currentCommit;
    const branchMatches = identity?.branch === record.workspace.currentBranch;

    // 7. Detect ongoing package-manager file activity.
    const pmActivityCheck = await handle.exec({
      command: 'test -d node_modules/.pnpm/tmp || test -d node_modules/.cache || test -f pnpm-lock.yaml.tmp; echo $?',
      cwd: '/workspace/repo',
      timeoutMs: 10_000,
      outputLimitBytes: 1_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch(() => ({ exitCode: 1, stdout: '1', stderr: '', truncated: false, durationMs: 0, artifactRefs: [] }));
    const pmActivity = pmActivityCheck.stdout.trim() === '0';

    // Determine the blocking process if any.
    const blockingProcessId = processReport.find(
      (process) => process.status === 'running' || process.status === 'starting' || process.status === 'unknown'
    )?.id;

    // Determine git integrity state.
    let state: 'consistent' | 'unknown' | 'diverged' | 'corrupted';
    let reason: string;
    let recommendedAction: string;
    let destructiveRecoveryRequired = false;
    let checkpointRestored = false;
    let trackedChangesPreserved = false;

    if (hasGitLock) {
      state = 'unknown';
      reason = 'git_lock_file_present';
      recommendedAction = blockingProcessId
        ? `Wait for or cancel process ${blockingProcessId}, then retry forge_doctor.`
        : 'A Git lock file exists but no managed process is blocking. Remove stale lock files or retry.';
    } else if (!gitHeadReadable) {
      state = 'corrupted';
      reason = 'git_head_unreadable';
      recommendedAction = 'The .git/HEAD file is missing or unreadable. A checkpoint restore may be required.';
      destructiveRecoveryRequired = true;
    } else if (!gitIndexReadable) {
      state = 'corrupted';
      reason = 'git_index_unreadable';
      recommendedAction = 'The Git index is corrupted. A checkpoint restore may be required.';
      destructiveRecoveryRequired = true;
    } else if (!workingTreeReadable) {
      state = 'unknown';
      reason = 'working_tree_unreadable';
      recommendedAction = 'The working tree is not readable. Check for ongoing filesystem mutations.';
    } else if (!headMatches || !branchMatches) {
      state = 'diverged';
      reason = 'head_or_branch_mismatch';
      recommendedAction = blockingProcessId
        ? `Process ${blockingProcessId} may be mutating the checkout. Cancel it, then retry.`
        : 'The recorded Git state differs from the filesystem. Do not restore a checkpoint — inspect manually.';
    } else if (pmActivity) {
      state = 'unknown';
      reason = 'package_manager_activity';
      recommendedAction = 'Package manager activity detected. Wait for it to complete, then retry.';
    } else {
      state = 'consistent';
      reason = 'all_checks_passed';
      recommendedAction = 'Workspace is consistent. No action needed.';
    }

    // 8-9. If destructive recovery is required and a checkpoint exists, preserve
    // tracked changes first, then restore.
    if (destructiveRecoveryRequired && record.workspace.activeSnapshotId) {
      // Preserve tracked working-tree changes before destructive recovery.
      try {
        const patch = await this.exportRecoveryPatch(record, 4_000_000);
        trackedChangesPreserved = true;
        // Restore the checkpoint.
        await this.recoverActiveCheckpoint(record);
        checkpointRestored = true;
        state = 'consistent';
        reason = 'checkpoint_restored';
        recommendedAction = 'A checkpoint was restored after corruption was detected. Verify your work.';
      } catch {
        // Could not preserve or restore — leave as corrupted.
      }
    }

    record.workspace.updatedAt = now;
    return {
      workspaceId: record.workspace.id,
      gitIntegrity: {
        state,
        reason,
        ...(blockingProcessId ? { blockingProcessId } : {}),
        gitHeadReadable,
        gitIndexReadable,
        workingTreeReadable,
        recommendedAction,
        destructiveRecoveryRequired
      },
      processes: processReport,
      dependencyState: dependencyStateView(record.dependencyState),
      trackedChangesPreserved,
      checkpointRestored,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: workspaceAllowedNextActions(record)
    };
  }

  /**
   * Install dependencies for the workspace using the detected package manager.
   * This is a first-class operation that:
   * - Detects packageManager from package.json.
   * - Uses the exact pinned version.
   * - Detects workspace layout.
   * - Decides frozen vs non-frozen lockfile based on whether manifests changed.
   * - Streams or persists logs.
   * - Retries safely after network failures.
   * - Handles memory limits.
   * - Updates the lockfile when explicitly allowed.
   * - Records the resulting lockfile hash.
   * - Creates a completion checkpoint.
   * - Reports whether dependencies are usable.
   */
  async dependenciesInstall(
    record: WorkspaceRuntimeRecord,
    input: {
      frozenLockfile?: boolean;
      allowLockfileUpdate?: boolean;
      networkPolicy: NetworkPolicyMode;
      timeoutMs?: number;
      idempotencyKey: string;
      expectedRevision?: number;
      /** Cap for an in-tool observational wait before returning processId. ChatGPT hosts time out long tool calls. */
      hostSafeWaitMs?: number;
    }
  ) {
    const timeoutMs = input.timeoutMs ?? 600_000;
    // Keep the tool response under typical ChatGPT transport budgets. The
    // install continues as a managed process; the agent finishes with process_wait.
    const hostSafeWaitMs = Math.min(input.hostSafeWaitMs ?? 25_000, timeoutMs, 45_000);
    const prior = record.idempotency[input.idempotencyKey];
    // Legacy sync-install idempotency entries have no processId; return the
    // recorded dependency state instead of starting a second install.
    if (prior && !prior.processId) {
      return {
        replay: true,
        replayed: true,
        idempotencyKey: input.idempotencyKey,
        originalOperationId: prior.operationId,
        workspaceId: record.workspace.id,
        operationId: prior.operationId,
        dependencyState: dependencyStateView(record.dependencyState),
        workspaceRevision: record.workspace.revision,
        allowedNextActions: workspaceAllowedNextActions(record),
        next_step: 'Dependencies install already recorded. Inspect forge_workspace_get before starting another install.'
      };
    }

    await this.syncProcessLifecycle(record).catch(() => undefined);
    const activeInstall = Object.entries(record.processes).find(([, entry]) =>
      !entry.completedAt &&
      /\b(pnpm|npm|yarn|bun|pip|uv)\b/i.test(entry.command) &&
      /\b(install|ci|sync)\b/i.test(entry.command)
    );
    if (activeInstall && (!prior?.processId || prior.processId !== activeInstall[0])) {
      const [activeProcessId, entry] = activeInstall;
      return {
        started: true,
        success: false,
        status: 'running' as const,
        workspaceId: record.workspace.id,
        processId: activeProcessId,
        managedProcess: true,
        command: entry.command,
        dependencyState: dependencyStateView(record.dependencyState),
        reusedActiveProcess: true,
        operationId: prior?.operationId ?? record.idempotency[input.idempotencyKey]?.operationId ?? ids.operation(),
        workspaceRevision: record.workspace.revision,
        allowedNextActions: ['forge_process_wait', 'forge_process_logs', 'forge_process_list'],
        next_step: `An install is already running as ${activeProcessId}. Call forge_process_wait with timeout_ms >= 600000 — do not start another install.`
      };
    }

    const handle = await this.handle(record, { allowRestore: false });

    // Ensure the package manager is available.
    await this.preparePackageManager(handle);

    // Detect the project.
    const detection = record.detection ?? await (await import('@forge/project-detection')).detectProject(handle);

    if (!detection.installCommand) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: 'No package manager or install command was detected for this project.',
        retryable: false,
        details: { packageManager: detection.packageManager }
      });
    }

    // Determine the lockfile hash before install.
    const lockfile = detection.packageManager === 'pnpm' ? 'pnpm-lock.yaml' :
      detection.packageManager === 'npm' ? 'package-lock.json' :
      detection.packageManager === 'yarn' ? 'yarn.lock' :
      detection.packageManager === 'bun' ? 'bun.lock' :
      detection.packageManager === 'uv' ? 'uv.lock' :
      detection.packageManager === 'pip' ? 'requirements.txt' : null;

    const lockfileHashBefore = lockfile
      ? await handle.exec({
          command: `sha256sum ${lockfile} 2>/dev/null | cut -d' ' -f1 || echo "none"`,
          cwd: '/workspace/repo',
          timeoutMs: 10_000,
          outputLimitBytes: 1_000,
          sessionId: 'agent-default',
          networkPolicy: 'deny_all'
        }).then((r) => r.stdout.trim()).catch(() => 'none')
      : 'none';

    // Choose the install command.
    let installCommand: string;
    if (input.allowLockfileUpdate) {
      installCommand = detection.installFallbackCommand ?? detection.installCommand;
    } else if (input.frozenLockfile === false) {
      installCommand = detection.installFallbackCommand ?? detection.installCommand;
    } else {
      installCommand = detection.installCommand;
    }

    // Managed background process so ChatGPT transport deadlines cannot restart
    // or orphan a long install. A short observational wait may finish fast
    // installs; otherwise return processId for forge_process_wait.
    const networkPolicy = input.networkPolicy === 'unrestricted_with_approval'
      ? 'package_install'
      : input.networkPolicy as Exclude<NetworkPolicyMode, 'unrestricted_with_approval'>;
    const started = await this.startProcess(record, {
      command: installCommand,
      cwd: '/workspace/repo',
      environment: nonInteractiveShellEnv(),
      networkPolicy,
      idempotencyKey: input.idempotencyKey,
      expectedRevision: input.expectedRevision,
      approved: true
    });
    const processId = started.value.id;
    const waited = await this.processWait(record, processId, hostSafeWaitMs);
    if (waited.timedOut) {
      return {
        started: true,
        success: false,
        status: 'running' as const,
        workspaceId: record.workspace.id,
        processId,
        managedProcess: true,
        packageManager: detection.packageManager,
        installCommand,
        lockfileHashBefore,
        dependencyState: waited.dependencyState,
        suggestedTimeoutMs: waited.suggestedTimeoutMs,
        replayed: 'replay' in started && started.replay === true,
        idempotencyKey: input.idempotencyKey,
        originalOperationId: started.operationId,
        operationId: started.operationId,
        workspaceRevision: record.workspace.revision,
        allowedNextActions: waited.allowedNextActions,
        next_step: waited.next_step
      };
    }

    const logs = await this.processLogs(record, processId).catch(() => ({ data: '', truncated: false }));
    const exitCode = waited.process.exitCode ?? 1;
    const dependencyState = waited.dependencyState;
    const success = exitCode === 0 && dependencyState.usable;
    const lockfileHashAfter = dependencyState.lockfileHash
      ?? (lockfile
        ? await handle.exec({
            command: `sha256sum ${lockfile} 2>/dev/null | cut -d' ' -f1 || echo "none"`,
            cwd: '/workspace/repo',
            timeoutMs: 10_000,
            outputLimitBytes: 1_000,
            sessionId: 'agent-default',
            networkPolicy: 'deny_all'
          }).then((r) => r.stdout.trim()).catch(() => 'none')
        : 'none');

    if (exitCode === 0 && !dependencyState.usable) {
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: 'Dependency install exited successfully but the installed package tree is not visible to the workspace shell.',
        retryable: true,
        details: {
          installCommand,
          lockfileHashAfter,
          processId,
          allowedNextActions: ['forge_doctor', 'forge_deps_install', 'forge_workspace_get']
        }
      });
    }

    const entry = record.processes[processId];
    return {
      workspaceId: record.workspace.id,
      started: true,
      success,
      status: success ? 'completed' as const : 'failed' as const,
      exitCode,
      packageManager: detection.packageManager,
      installCommand,
      lockfileHashBefore,
      lockfileHashAfter,
      lockfileChanged: lockfileHashBefore !== lockfileHashAfter,
      dependencyState,
      processId,
      managedProcess: true,
      filesystemCommitted: Boolean(waited.filesystemCommitted),
      checkpoint: entry?.checkpointAfter
        ? { snapshotId: entry.checkpointAfter, createdAt: entry.completedAt ?? new Date().toISOString(), providerVersion: 'process' }
        : undefined,
      replayed: 'replay' in started && started.replay === true,
      idempotencyKey: input.idempotencyKey,
      originalOperationId: started.operationId,
      operationId: started.operationId,
      workspaceRevision: record.workspace.revision,
      stderr: logs.data.slice(-2_000),
      stdout: logs.data.slice(0, 1_000),
      allowedNextActions: success
        ? ['forge_shell', 'forge_git_status', 'forge_workspace_get']
        : ['forge_deps_install', 'forge_doctor', 'forge_workspace_get'],
      next_step: success
        ? 'Dependencies are usable. Continue with forge_shell / validation.'
        : 'Dependency install failed. Inspect logs with forge_process_logs, then retry with a new idempotency key only if needed.'
    };
  }
  private async adoptOwnedGitTransition(
    record: WorkspaceRuntimeRecord,
    handle: SandboxHandle,
    expected?: { branch?: string }
  ): Promise<{ commit: string; branch?: string }> {
    const identity = await this.gitIdentity(handle);
    if (expected?.branch !== undefined && identity.branch !== expected.branch) {
      this.noteGitDivergence(record, identity);
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED',
        message: 'Forge Git mutation completed with an unexpected checked-out branch.',
        retryable: false,
        details: { workspaceId: record.workspace.id, expectedBranch: expected.branch, observedBranch: identity.branch ?? null }
      });
    }
    record.workspace.currentCommit = identity.commit;
    record.workspace.currentBranch = identity.branch;
    record.lastGitDivergence = undefined;
    record.workspace.updatedAt = new Date().toISOString();
    return identity;
  }

  async exposePreview(
    record: WorkspaceRuntimeRecord,
    input: {
      processId: ProcessId;
      port: number;
      hostname: string;
      access: 'private' | 'tenant' | 'share-link' | 'public';
      ttlSeconds: number;
      idempotencyKey: string;
      expectedRevision?: number;
    }
  ) {
    if (input.access === 'public') {
      throw new ForgeError({
        code: 'FORGE_APPROVAL_REQUIRED',
        message: 'Public previews require explicit approval.',
        retryable: false
      });
    }
    if (!record.processes[input.processId]) {
      throw new ForgeError({
        code: 'FORGE_PROCESS_NOT_FOUND',
        message: 'The preview process was not found.',
        retryable: false
      });
    }
    const operation = this.beginMutation(
      record,
      input.expectedRevision,
      input.idempotencyKey
    );
    if (operation.replay) {
      return {
        replay: true,
        operationId: operation.operationId,
        workspaceRevision: record.workspace.revision
      };
    }
    const previewId = ids.preview();
    const endpoint = await (await this.handle(record)).exposePort({
      port: input.port,
      hostname: input.hostname,
      name: previewId,
      token: crypto.randomUUID().replaceAll('-', '').slice(0, 16)
    });
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    record.previews[previewId] = {
      port: input.port,
      processId: input.processId,
      providerUrl: endpoint.providerUrl,
      access: input.access,
      expiresAt
    };
    return {
      previewId,
      expiresAt,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision
    };
  }

  async gitStatus(record: WorkspaceRuntimeRecord) {
    const result = await this.exec(record, {
      command: 'git status --porcelain=v2 --branch',
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
      outputLimitBytes: 200_000,
      networkPolicy: 'deny_all'
    });
    const changed = await (await this.handle(record)).exec({
      command: 'git diff --name-only -z && git diff --cached --name-only -z && git ls-files --others --exclude-standard -z',
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 200_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (changed.exitCode !== 0 || changed.truncated) throw new ForgeError({ code: 'FORGE_OUTPUT_TRUNCATED', message: 'Forge could not completely enumerate workspace changes.', retryable: false, details: { truncated: changed.truncated } });
    const changedPaths = [...new Set(changed.stdout.split('\0').filter(Boolean))];
    return {
      workspaceId: record.workspace.id,
      repository: record.workspace.repository,
      raw: result.stdout,
      commit: record.workspace.currentCommit,
      baseCommit: record.workspace.baseCommit ?? null,
      filesystemRevision: record.workspace.revision,
      changedPaths,
      sync: {
        state: record.workspace.currentCommit && record.workspace.currentCommit === record.workspace.lastPushedCommit && record.workspace.currentBranch === record.workspace.lastPushedBranch ? 'pushed' : 'unpushed',
        lastPushedCommit: record.workspace.lastPushedCommit ?? null,
        lastPushedBranch: record.workspace.lastPushedBranch ?? null
      },
      clean: !result.stdout
        .split('\n')
        .some(
          (line) =>
            line.startsWith('1 ') ||
            line.startsWith('2 ') ||
            line.startsWith('? ')
        ),
      // Promoted from the workspace record (not re-derived from `raw`) so an
      // agent sees push/loss state at a glance instead of it being buried in
      // porcelain output it has to parse itself.
      branch: record.workspace.currentBranch ?? record.workspace.requestedRef,
      hasUnpushedWork: record.workspace.hasUnpushedWork === true,
      ...(record.workspace.dataLoss ? { dataLoss: record.workspace.dataLoss } : {})
    };
  }

  private async untrackedFiles(record: WorkspaceRuntimeRecord) {
    const handle = await this.handle(record);
    return this.untrackedFilesForHandle(handle);
  }

  private async untrackedFilesForHandle(handle: SandboxHandle) {
    const listed = await handle.exec({
      command: 'git ls-files --others --exclude-standard -z',
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 200_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (listed.exitCode !== 0 || listed.truncated) throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Forge could not completely enumerate untracked files.', retryable: false, details: { truncated: listed.truncated } });
    return Promise.all(listed.stdout.split('\0').filter(Boolean).map(async (path) => {
      const file = await handle.readFile({ path: `/workspace/repo/${path}`, maxBytes: 1 });
      return { path, sha256: file.sha256, sizeBytes: file.sizeBytes };
    }));
  }

  private async shellFileSha256(record: WorkspaceRuntimeRecord, path: string) {
    const handle = await this.handle(record);
    const result = await handle.exec({
      command: `sha256sum -- ${quoted(path)}`,
      cwd: '/workspace/repo', timeoutMs: 10_000, outputLimitBytes: 1_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    const sha256 = result.stdout.trim().split(/\s+/u)[0] ?? '';
    if (result.exitCode !== 0 || !/^[a-f0-9]{64}$/u.test(sha256)) throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: 'Forge could not verify the file through the shell filesystem mount.', retryable: false, details: { path } });
    return sha256;
  }

  private async gitWorktree(record: WorkspaceRuntimeRecord) {
    return this.worktreeFromHandle(await this.handle(record));
  }

  private async worktreeFromHandle(handle: SandboxHandle) {
    const result = await handle.exec({
      command: 'git diff --no-ext-diff --binary && git diff --cached --no-ext-diff --binary',
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 1_000_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0 || result.truncated) throw new ForgeError({ code: 'FORGE_OUTPUT_TRUNCATED', message: 'Forge could not calculate a complete worktree state.', retryable: false, details: { truncated: result.truncated } });
    const untrackedFiles = await this.untrackedFilesForHandle(handle);
    return { diff: result.stdout, untrackedFiles, hash: await sha256Text(JSON.stringify({ diff: result.stdout, untrackedFiles })) };
  }

  private async workspaceManifest(handle: SandboxHandle): Promise<NonNullable<WorkspaceCheckpoint['manifest']>> {
    const identity = await this.gitIdentity(handle);
    // Snapshot captures /workspace with gitignored files included. Do not hash
    // tar metadata here: a restored FUSE overlay can legitimately alter mount
    // and directory metadata even when every durable byte is identical. Hash a
    // sorted semantic manifest instead — path, entry kind, regular-file bytes,
    // and symlink target. Empty directories are included; volatile modes and
    // timestamps are deliberately excluded.
    const archive = await handle.exec({
      command: "bash -o pipefail -c \"find /workspace -xdev -mindepth 1 \\( -type d -o -type f -o -type l \\) -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' path; do rel=\\${path#/workspace/}; if test -d \\\"\\$path\\\"; then printf 'd\\0%s\\0' \\\"\\$rel\\\"; elif test -L \\\"\\$path\\\"; then printf 'l\\0%s\\0%s\\0' \\\"\\$rel\\\" \\\"\\$(readlink \\\"\\$path\\\")\\\"; else printf 'f\\0%s\\0' \\\"\\$rel\\\"; sha256sum \\\"\\$path\\\"; fi; done | sha256sum\"",
      cwd: '/workspace', timeoutMs: 120_000, outputLimitBytes: 1_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    const workspaceHash = archive.stdout.trim().split(/\s+/u)[0] ?? '';
    if (archive.exitCode !== 0 || archive.truncated || !/^[a-f0-9]{64}$/u.test(workspaceHash)) {
      throw new ForgeError({
        code: 'FORGE_SNAPSHOT_INCOMPATIBLE',
        message: 'Forge could not calculate a complete filesystem manifest for the checkpoint.',
        retryable: true,
        details: { truncated: archive.truncated }
      });
    }
    return { ...identity, workspaceHash, workspaceHashAlgorithm: 'content-v2' };
  }

  async proveWorkspaceState(record: WorkspaceRuntimeRecord) {
    const recorded = { commit: record.workspace.currentCommit, branch: record.workspace.currentBranch, baseCommit: record.workspace.baseCommit };
    await this.reconcileGitState(record);
    const status = await this.gitStatus(record);
    const worktree = await this.gitWorktree(record);
    const baseCommit = record.workspace.baseCommit ?? record.workspace.currentCommit;
    const handle = await this.handle(record);
    const outgoing = await handle.exec({
      command: `git diff --name-only -z ${quoted(baseCommit ?? 'HEAD')}...HEAD; printf '\n__FORGE_DIFF__\n'; git diff --binary ${quoted(baseCommit ?? 'HEAD')}...HEAD`,
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 1_000_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (outgoing.exitCode !== 0 || outgoing.truncated) throw new ForgeError({ code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED', message: 'Forge could not prove the complete outgoing Git state against the immutable base.', retryable: false, details: { baseCommit, truncated: outgoing.truncated } });
    const marker = '\n__FORGE_DIFF__\n';
    const separator = outgoing.stdout.indexOf(marker);
    if (separator < 0) throw new ForgeError({ code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED', message: 'Forge received an incomplete Git proof response.', retryable: false });
    const names = outgoing.stdout.slice(0, separator).split('\0').filter(Boolean);
    const diff = outgoing.stdout.slice(separator + marker.length);
    const files = await Promise.all(names.slice(0, 200).map(async (path) => {
      const filesystem = await handle.readFile({ path: `/workspace/repo/${path}`, maxBytes: 1_000_000 }).catch(() => undefined);
      const head = await handle.exec({ command: `git show HEAD:${quoted(path)}`, cwd: '/workspace/repo', timeoutMs: 10_000, outputLimitBytes: 1_000_000, sessionId: 'system', networkPolicy: 'deny_all' });
      return { path, filesystemSha256: filesystem?.sha256 ?? null, headSha256: head.exitCode === 0 ? await sha256Text(head.stdout) : null };
    }));
    const uncommittedFiles = await Promise.all(status.changedPaths.slice(0, 200).map(async (path) => {
      const filesystem = await handle.readFile({ path: `/workspace/repo/${path}`, maxBytes: 1_000_000 }).catch(() => undefined);
      const head = await handle.exec({ command: `git show HEAD:${quoted(path)}`, cwd: '/workspace/repo', timeoutMs: 10_000, outputLimitBytes: 1_000_000, sessionId: 'system', networkPolicy: 'deny_all' });
      return { path, filesystemSha256: filesystem?.sha256 ?? null, headSha256: head.exitCode === 0 ? await sha256Text(head.stdout) : null };
    }));
    return { workspaceId: record.workspace.id, repository: record.workspace.repository, recorded, observed: { commit: record.workspace.currentCommit, branch: record.workspace.currentBranch, baseCommit }, status, uncommittedDiffHash: worktree.hash, untrackedFiles: worktree.untrackedFiles, committedOutgoingDiffHash: await sha256Text(diff), changedPaths: names, files, uncommittedFiles, gitDivergence: record.lastGitDivergence ?? null, remoteBranch: { state: 'not_verified', reason: 'Remote verification requires a fresh repository-scoped capability and is not inferred from local metadata.' } };
  }

  async exportRecoveryPatch(record: WorkspaceRuntimeRecord, maxBytes: number) {
    const proof = await this.proveWorkspaceState(record);
    const baseCommit = record.workspace.baseCommit ?? record.workspace.currentCommit ?? 'HEAD';
    const result = await (await this.handle(record)).exec({
      command: `git diff --binary ${quoted(baseCommit)}...HEAD; printf '\n__FORGE_UNCOMMITTED__\n'; git diff --no-ext-diff --binary; git diff --cached --no-ext-diff --binary; printf '\n__FORGE_UNTRACKED_ARCHIVE_BASE64__\n'; list=/workspace/tmp/forge-untracked-$$.list; git ls-files --others --exclude-standard -z > "$list"; if [ -s "$list" ]; then tar --null --files-from="$list" -czf - | base64; fi; rm -f "$list"`,
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: maxBytes,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0 || result.truncated) throw new ForgeError({ code: 'FORGE_OUTPUT_TRUNCATED', message: 'Forge could not create a complete recovery patch within the requested export limit.', retryable: false, details: { maxBytes, truncated: result.truncated } });
    const manifest = JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), proof, includes: ['committed binary diff against immutable base', 'uncommitted staged and unstaged binary diff', 'base64 tar.gz archive of every untracked file'], restore: 'Apply the committed and uncommitted patch sections to a checkout of baseCommit, then decode the __FORGE_UNTRACKED_ARCHIVE_BASE64__ section with base64 -d | tar -xzf -.' }, null, 2);
    return { content: `${manifest}\n\n__FORGE_PATCH__\n${result.stdout}`, proof };
  }

  /**
   * One page of a diff, selected by file. See the paging note above
   * `parseNumstatZ` for why diffs are never returned whole.
   *
   * `selector` is whatever goes after `git diff` to choose the revisions
   * ('' for the working tree, '--cached' for the index, 'base...HEAD' for the
   * outgoing change). Callers must have validated it — it is interpolated into
   * a shell command.
   */
  private async diffPage(
    record: WorkspaceRuntimeRecord,
    options: {
      selector: string;
      cursor?: number;
      maxBytes: number;
      maxFiles?: number;
      paths?: string[];
      withHash?: boolean;
    }
  ): Promise<DiffPageResult> {
    const maxBytes = Math.max(2_000, Math.min(options.maxBytes, 400_000));
    const maxFiles = options.maxFiles ?? 50;
    const handle = await this.handle(record);
    // `--literal-pathspecs`: a page's paths come back from git and go straight
    //   out again as a pathspec, so a path containing `*` or `?` must not be
    //   re-interpreted as a glob and pull in files this page never planned for.
    // `core.quotePath=false`: otherwise git octal-escapes any non-ASCII path in
    //   the diff HEADER ("a/caf\303\251.md") while `files` reports it verbatim,
    //   so the two disagree about what the same file is called.
    const git = `git -c core.quotePath=false --literal-pathspecs diff --no-ext-diff ${options.selector}`.trimEnd();

    // Probe: the complete file list, plus (for the outgoing diff) a hash over
    // the whole change. Both stay small regardless of how large the content is
    // — numstat scales with file count, sha256sum emits 64 hex characters.
    const probe = await handle.exec({
      command: `sh -c ${quoted([
        'echo ===FORGE_NUMSTAT===',
        `${git} --numstat -z`,
        'echo',
        'echo ===FORGE_HASH===',
        options.withHash ? `${git} --binary | sha256sum` : 'echo'
      ].join('\n'))}`,
      cwd: '/workspace/repo',
      timeoutMs: 60_000,
      outputLimitBytes: 1_000_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    if (probe.exitCode !== 0) {
      throw new ForgeError({
        code: 'FORGE_GIT_DIRTY',
        message: 'Forge could not read the diff.',
        retryable: false,
        details: { stderr: probe.stderr.slice(0, 2_000) }
      });
    }

    const marker = (name: string): string => {
      const start = probe.stdout.indexOf(name);
      if (start === -1) return '';
      const from = start + name.length;
      const next = probe.stdout.indexOf('===FORGE_', from);
      // Deliberately NOT trimmed: numstat records are NUL-terminated and the
      // paths inside them may legitimately start or end with whitespace.
      return probe.stdout.slice(from, next === -1 ? probe.stdout.length : next);
    };

    let files = parseNumstatZ(marker('===FORGE_NUMSTAT==='));
    const diffHash = options.withHash ? (marker('===FORGE_HASH===').trim().split(/\s+/)[0] ?? '') : '';

    // A file list long enough to hit the probe cap means `files` is short of
    // the truth. Say so rather than quietly under-reporting the change.
    const fileListTruncated = probe.truncated === true;

    // An explicit `paths` request narrows the list before paging, so a caller
    // can jump straight to one large file instead of paging up to it.
    if (options.paths?.length) {
      const wanted = new Set(options.paths);
      files = files.filter((file) => wanted.has(file.path) || (file.previousPath !== undefined && wanted.has(file.previousPath)));
    }

    const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
    const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const plan = planDiffPage(files, options.cursor ?? 0, maxBytes, maxFiles);

    let diff = '';
    let truncated = false;
    if (plan.pathspecs.length > 0) {
      // Headroom above the planner's budget so a slightly-underestimated page
      // still arrives whole; only a genuinely oversized file gets cut.
      const page = await handle.exec({
        command: `${git} --binary -- ${plan.pathspecs.map(quoted).join(' ')}`,
        cwd: '/workspace/repo',
        timeoutMs: 60_000,
        outputLimitBytes: maxBytes + 64_000,
        sessionId: 'system',
        networkPolicy: 'deny_all'
      });
      if (page.exitCode !== 0) {
        throw new ForgeError({
          code: 'FORGE_GIT_DIRTY',
          message: 'Forge could not read the diff for this page of files.',
          retryable: false,
          details: { stderr: page.stderr.slice(0, 2_000) }
        });
      }
      diff = page.stdout;
      truncated = page.truncated === true;
    }

    const hasMore = plan.nextIndex !== null;
    return {
      diff,
      files: files.map(({ path, additions, deletions, binary }) => ({ path, additions, deletions, binary })),
      totalFiles: files.length,
      totalAdditions,
      totalDeletions,
      pageFiles: plan.paths,
      ...(plan.fromIndex > 0 ? { cursor: String(plan.fromIndex) } : {}),
      // Always emit nextCursor so strict hosts do not have to treat absence as
      // "maybe more" — null means the page is complete.
      nextCursor: hasMore ? String(plan.nextIndex) : null,
      hasMore,
      truncated,
      ...(fileListTruncated ? { fileListTruncated } : {}),
      ...(options.withHash ? { diffHash } : {}),
      note: diffPageNote({
        shown: plan.paths.length,
        total: files.length,
        hasMore,
        truncated,
        fileListTruncated
      })
    };
  }

  async gitDiff(
    record: WorkspaceRuntimeRecord,
    staged = false,
    paging: { cursor?: number; maxBytes?: number; paths?: string[] } = {}
  ) {
    return this.diffPage(record, {
      selector: staged ? '--cached' : '',
      cursor: paging.cursor,
      maxBytes: paging.maxBytes ?? 64_000,
      paths: paging.paths
    });
  }

  async gitBranchCreate(
    record: WorkspaceRuntimeRecord,
    branch: string,
    expectedRevision: number | undefined,
    idempotencyKey: string
  ) {
    assertForgeBranch(branch);
    const operation = this.beginMutation(record, expectedRevision, idempotencyKey);
    if (operation.replay) return { replay: true, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
    const handle = await this.handle(record);
    const result = await handle.exec({
      command: `git switch -c ${quoted(branch)}`,
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 50_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0) throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Forge could not create the branch.', retryable: false });
    await this.adoptOwnedGitTransition(record, handle, { branch });
    record.workspace.hasUnpushedWork = true;
    return { branch, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
  }

  async gitCommit(
    record: WorkspaceRuntimeRecord,
    input: { message: string; paths: string[]; expectedRevision?: number; idempotencyKey: string }
  ) {
    assertForgeBranch(record.workspace.currentBranch ?? '');
    if (!input.message.trim() || input.message.length > 500) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Commit message is invalid.', retryable: false });
    const paths = input.paths.length ? input.paths : ['.'];
    if (paths.some((path) => path.startsWith('/') || path.includes('..') || path.includes('\0'))) {
      throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Commit paths must stay inside the repository.', retryable: false });
    }
    const operation = this.beginMutation(record, input.expectedRevision, input.idempotencyKey);
    if (operation.replay) return { replay: true, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
    const handle = await this.handle(record);
    // Fuse stage + commit + identity into a single container round-trip. The
    // `&&` chain preserves ordering and short-circuits, so a failed stage still
    // surfaces before the commit runs. rev-parse is last in the chain, so the
    // real SHA is the final bare object-name line of stdout.
    const commit = await handle.exec({
      command: `sh -c ${quoted(
        `git add -- ${paths.map(quoted).join(' ')} && git commit -m ${quoted(input.message.trim())} && git rev-parse HEAD && git branch --show-current`
      )}`,
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 100_000,
      sessionId: 'system', networkPolicy: 'deny_all',
      environment: {
        GIT_AUTHOR_NAME: 'forge-mcp[bot]',
        GIT_AUTHOR_EMAIL: 'forge-mcp[bot]@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'forge-mcp[bot]',
        GIT_COMMITTER_EMAIL: 'forge-mcp[bot]@users.noreply.github.com'
      }
    });
    if (commit.exitCode !== 0) throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Forge could not create the commit.', retryable: false, details: { stderr: commit.stderr.slice(0, 2_000) } });
    // Parse HEAD defensively instead of blindly taking the last stdout line: a
    // commit-msg / post-commit hook that echoes to stdout runs DURING `git commit`
    // (before rev-parse), so the genuine object name is the LAST line that is a
    // bare 40-hex (or 64-hex, sha256 repos) object name. Require a clean match or
    // fail loudly — never persist a hook-poisoned currentCommit.
    const head = commit.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line))
      .pop();
    if (!head) {
      throw new ForgeError({
        code: 'FORGE_GIT_DIRTY',
        message: 'Forge created the commit but could not resolve a valid HEAD SHA.',
        retryable: false,
        details: { stderr: commit.stderr.slice(0, 2_000) }
      });
    }
    const outputLines = commit.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const tail = outputLines.at(-1);
    const observedBranch = tail === head ? record.workspace.currentBranch : tail;
    if (observedBranch !== record.workspace.currentBranch) {
      this.noteGitDivergence(record, { commit: head, branch: observedBranch });
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED',
        message: 'Forge commit completed with an unexpected checked-out branch.',
        retryable: false,
        details: {
          commit: head,
          expectedBranch: record.workspace.currentBranch ?? null,
          observedBranch: observedBranch ?? null
        }
      });
    }
    record.workspace.currentCommit = head;
    record.workspace.currentBranch = observedBranch;
    record.lastGitDivergence = undefined;
    record.workspace.updatedAt = new Date().toISOString();
    record.workspace.hasUnpushedWork = true;
    return { commit: record.workspace.currentCommit, branch: record.workspace.currentBranch, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
  }

  /**
   * The outgoing change, one page of files at a time.
   *
   * `diffHash` is computed inside the container over the COMPLETE diff, so it
   * is identical on every page and is safe to carry into a push from any of
   * them. It previously hashed the Worker-side stdout, which the exec cap
   * silently truncated at 1 MB — meaning a large change could be approved and
   * pushed against a hash of only its first megabyte.
   */
  async gitOutgoingDiff(
    record: WorkspaceRuntimeRecord,
    base: string,
    paging: { cursor?: number; maxBytes?: number; paths?: string[] } = {}
  ) {
    assertRef(base);
    if (base !== record.workspace.requestedRef) {
      throw new ForgeError({
        code: 'FORGE_GIT_PUSH_BLOCKED',
        message: 'Forge only compares and submits against the immutable base ref recorded when this workspace was created.',
        retryable: false,
        details: {
          requestedBase: record.workspace.requestedRef,
          providedBase: base,
          baseCommit: record.workspace.baseCommit ?? null
        }
      });
    }
    const immutableBase = record.workspace.baseCommit ?? base;
    const page = await this.diffPage(record, {
      selector: `${quoted(immutableBase)}...HEAD`,
      cursor: paging.cursor,
      maxBytes: paging.maxBytes ?? 64_000,
      paths: paging.paths,
      withHash: true
    });
    return { ...page, branch: record.workspace.currentBranch, base, baseCommit: immutableBase };
  }

  /**
   * Every path in the outgoing change — complete, cheap, and independent of
   * paging. Push-envelope checks must use this rather than parsing whatever
   * hunks a page happened to carry, or a file outside the envelope's allowed
   * paths could ride along unnoticed simply by sorting after the page cut.
   */
  async gitOutgoingPaths(record: WorkspaceRuntimeRecord, base: string): Promise<string[]> {
    assertRef(base);
    if (base !== record.workspace.requestedRef) {
      throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'Forge only compares and submits against the immutable base ref recorded when this workspace was created.', retryable: false, details: { requestedBase: record.workspace.requestedRef, providedBase: base, baseCommit: record.workspace.baseCommit ?? null } });
    }
    const immutableBase = record.workspace.baseCommit ?? base;
    const result = await (await this.handle(record)).exec({
      command: `git -c core.quotePath=false --literal-pathspecs diff --no-ext-diff --name-only -z ${quoted(immutableBase)}...HEAD`,
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 1_000_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0) {
      throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Forge could not list the outgoing paths.', retryable: false });
    }
    if (result.truncated) {
      // Fail closed: a partial path list would let an envelope check pass on
      // files it never saw.
      throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'The outgoing change touches too many files to verify against a push envelope.', retryable: false });
    }
    return result.stdout.split('\0').map((path) => path.replace(/^[\r\n]+/, '')).filter(Boolean);
  }

  // True iff `ancestor` is an ancestor of (or equal to) HEAD — i.e. HEAD only
  // ever moved forward from it, no rewritten history. Used to gate push-
  // envelope auto-approval: an envelope only ever covers a fast-forward.
  async gitIsAncestor(record: WorkspaceRuntimeRecord, ancestor: string): Promise<boolean> {
    const result = await (await this.handle(record)).exec({
      command: `git merge-base --is-ancestor ${quoted(ancestor)} HEAD`,
      cwd: '/workspace/repo', timeoutMs: 15_000, outputLimitBytes: 1_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    return result.exitCode === 0;
  }

  async gitPush(
    record: WorkspaceRuntimeRecord,
    input: { branch: string; expectedDiffHash: string; base: string; source: RepositoryCloneSource; expectedRevision?: number; idempotencyKey: string }
  ) {
    assertForgeBranch(input.branch);
    if (record.workspace.currentBranch !== input.branch) throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'The requested branch is not checked out.', retryable: false });
    const outgoing = await this.gitOutgoingDiff(record, input.base);
    if (outgoing.diffHash !== input.expectedDiffHash) throw new ForgeError({ code: 'FORGE_STALE_REVISION', message: 'The outgoing diff changed after approval was requested.', retryable: false });
    const operation = this.beginMutation(record, input.expectedRevision, input.idempotencyKey);
    if (operation.replay) return { replay: true, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
    const configPath = `/workspace/tmp/gitconfig-push-${record.workspace.id}`;
    if (!input.source.authorizationHeader) throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'GitHub App authorization is required for push.', retryable: false });
    const handle = await this.handle(record);
    await handle.writeFile({ path: configPath, content: `[http]\n\textraHeader = ${input.source.authorizationHeader}\n` });
    try {
      const result = await handle.exec({
        command: `git push ${quoted(input.source.url)} HEAD:${quoted(`refs/heads/${input.branch}`)}`,
        cwd: '/workspace/repo', timeoutMs: 120_000, outputLimitBytes: 200_000,
        sessionId: 'system', networkPolicy: 'development',
        environment: { GIT_CONFIG_GLOBAL: configPath, GIT_TERMINAL_PROMPT: '0' }
      });
      if (result.exitCode !== 0) throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'GitHub rejected the Forge branch push.', retryable: false, details: { stderr: result.stderr.slice(0, 2_000) } });
      const remote = await handle.exec({
        command: `git ls-remote --exit-code ${quoted(input.source.url)} ${quoted(`refs/heads/${input.branch}`)}`,
        cwd: '/workspace/repo', timeoutMs: 60_000, outputLimitBytes: 10_000,
        sessionId: 'system', networkPolicy: 'development',
        environment: { GIT_CONFIG_GLOBAL: configPath, GIT_TERMINAL_PROMPT: '0' }
      });
      const remoteCommit = remote.stdout.trim().split(/\s+/u)[0] ?? '';
      if (remote.exitCode !== 0 || remoteCommit !== record.workspace.currentCommit) {
        throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'Forge pushed the branch but could not verify that the remote ref resolves to the submitted commit.', retryable: false, details: { branch: input.branch, expectedCommit: record.workspace.currentCommit, observedRemoteCommit: remoteCommit || null, stderr: remote.stderr.slice(0, 2_000) } });
      }
    } finally {
      await handle.exec({ command: `rm -f ${quoted(configPath)}`, cwd: '/workspace', timeoutMs: 10_000, outputLimitBytes: 1_000, sessionId: 'system', networkPolicy: 'deny_all' }).catch(() => undefined);
    }
    record.workspace.lastPushedCommit = record.workspace.currentCommit;
    record.workspace.lastPushedBranch = input.branch;
    record.workspace.updatedAt = new Date().toISOString();
    // Work is now pushed to GitHub — safe for the reaper to reclaim on idle.
    record.workspace.hasUnpushedWork = false;
    return { branch: input.branch, commit: record.workspace.currentCommit, diffHash: outgoing.diffHash, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
  }

  /**
   * Best-effort safety push, run by the idle reaper immediately before it
   * tears down a dirty workspace. Pushes HEAD to a Forge-owned backup ref
   * (forge/backup/<workspaceId>, never a real branch a human would build on
   * or PR from) so real work has a durable copy on GitHub instead of relying
   * solely on the tar-to-R2 snapshot — a git push moves only the object
   * delta (fast, small, and its exit code is a real success/failure signal),
   * where a full-workspace tar of node_modules etc. is slow, large, and can
   * silently come back empty under the same resource pressure that's often
   * WHY the workspace went idle-and-unreachable in the first place. No
   * approval gate: this never reaches a mergeable location, it only exists
   * so data isn't gone forever if the container is destroyed a moment later.
   */
  /**
   * Force-push the workspace HEAD to an arbitrary Forge-owned ref.
   *
   * Shared by two callers with the same shape but different intent: the idle
   * reaper's last-gasp backup before destroying a dirty workspace, and staging a
   * submission so it can outlive the workspace while it waits for a human to
   * approve it. Never targets a ref the user would treat as theirs — callers pass
   * a `forge/`-namespaced ref — so it needs no approval of its own.
   */
  async pushToRef(
    record: WorkspaceRuntimeRecord,
    source: RepositoryCloneSource,
    ref: string
  ): Promise<{ pushed: boolean; ref?: string; reason?: string }> {
    if (!record.workspace.currentBranch) return { pushed: false, reason: 'no branch checked out' };
    if (!source.authorizationHeader) return { pushed: false, reason: 'no GitHub App authorization' };
    const configPath = `/workspace/tmp/gitconfig-push-${record.workspace.id}`;
    try {
      const handle = await this.handle(record);
      await handle.writeFile({ path: configPath, content: `[http]\n\textraHeader = ${source.authorizationHeader}\n` });
      try {
        const result = await handle.exec({
          command: `git push --force ${quoted(source.url)} HEAD:${quoted(`refs/heads/${ref}`)}`,
          cwd: '/workspace/repo', timeoutMs: 60_000, outputLimitBytes: 50_000,
          sessionId: 'system', networkPolicy: 'development',
          environment: { GIT_CONFIG_GLOBAL: configPath, GIT_TERMINAL_PROMPT: '0' }
        });
        return result.exitCode === 0
          ? { pushed: true, ref }
          : { pushed: false, reason: result.stderr.slice(0, 500) };
      } finally {
        await handle.exec({ command: `rm -f ${quoted(configPath)}`, cwd: '/workspace', timeoutMs: 10_000, outputLimitBytes: 1_000, sessionId: 'system', networkPolicy: 'deny_all' }).catch(() => undefined);
      }
    } catch (error) {
      return { pushed: false, reason: error instanceof Error ? error.message.slice(0, 500) : 'unknown' };
    }
  }

  async backupUnpushedWork(
    record: WorkspaceRuntimeRecord,
    source: RepositoryCloneSource
  ): Promise<{ pushed: boolean; ref?: string; reason?: string }> {
    if (!record.workspace.hasUnpushedWork || !record.workspace.currentBranch) {
      return { pushed: false, reason: 'nothing to back up' };
    }
    return this.pushToRef(record, source, `forge/backup/${record.workspace.id}`);
  }

  async assertDestroySafe(record: WorkspaceRuntimeRecord, cloneSource?: RepositoryCloneSource): Promise<void> {
    await this.reconcileGitState(record);
    const status = await this.gitStatus(record);
    if (!status.clean || status.sync.state !== 'pushed') {
      throw new ForgeError({
        code: 'FORGE_GIT_PUSH_BLOCKED',
        message: 'Forge will not destroy a workspace with uncommitted or unpushed work. Reconcile, commit, and push the current Forge branch first.',
        retryable: false,
        details: { clean: status.clean, sync: status.sync }
      });
    }
    await this.assertRemoteRef(record, await this.handle(record), cloneSource);
  }

  private async assertRemoteRef(
    record: WorkspaceRuntimeRecord,
    handle: SandboxHandle,
    cloneSource?: RepositoryCloneSource
  ): Promise<void> {
    const branch = record.workspace.lastPushedBranch;
    const commit = record.workspace.lastPushedCommit;
    if (!branch || !commit) {
      throw new ForgeError({
        code: 'FORGE_GIT_PUSH_BLOCKED',
        message: 'Forge cannot prove a remote branch without a recorded pushed branch and commit.',
        retryable: false
      });
    }
    const configPath = `/workspace/tmp/gitconfig-remote-${record.workspace.id}`;
    const remoteTarget = cloneSource ? quoted(cloneSource.url) : 'origin';
    if (cloneSource?.authorizationHeader) {
      await handle.writeFile({
        path: configPath,
        content: `[http]\n\textraHeader = ${cloneSource.authorizationHeader}\n`
      });
    }
    let remote;
    try {
      remote = await handle.exec({
        command: `git ls-remote --exit-code ${remoteTarget} ${quoted(`refs/heads/${branch}`)}`,
        cwd: '/workspace/repo',
        timeoutMs: 60_000,
        outputLimitBytes: 10_000,
        sessionId: 'system',
        networkPolicy: 'development',
        environment: cloneSource?.authorizationHeader
          ? { GIT_CONFIG_GLOBAL: configPath, GIT_TERMINAL_PROMPT: '0' }
          : { GIT_TERMINAL_PROMPT: '0' }
      });
    } finally {
      if (cloneSource?.authorizationHeader) {
        await handle.exec({
          command: `rm -f ${quoted(configPath)}`,
          cwd: '/workspace',
          timeoutMs: 10_000,
          outputLimitBytes: 1_000,
          sessionId: 'system',
          networkPolicy: 'deny_all'
        }).catch(() => undefined);
      }
    }
    if (!remote) {
      throw new ForgeError({
        code: 'FORGE_GIT_PUSH_BLOCKED',
        message: 'Forge could not verify the remote branch with a fresh repository-scoped capability.',
        retryable: true,
        details: { branch, expectedCommit: commit }
      });
    }
    const remoteCommit = remote.stdout.trim().split(/\s+/u)[0] ?? '';
    if (remote.exitCode !== 0 || remote.truncated || remoteCommit !== commit) {
      throw new ForgeError({
        code: 'FORGE_GIT_PUSH_BLOCKED',
        message: 'Forge will not destroy a workspace until the remote branch is proven to resolve to the recorded pushed commit.',
        retryable: false,
        details: {
          branch,
          expectedCommit: commit,
          observedRemoteCommit: remoteCommit || null,
          truncated: remote.truncated,
          stderr: remote.stderr.slice(0, 2_000)
        }
      });
    }
  }

  requestDestroy(
    record: WorkspaceRuntimeRecord,
    expectedRevision: number | undefined,
    idempotencyKey: string,
    force = false
  ) {
    const prior = record.idempotency[idempotencyKey];
    if (prior) {
      return {
        operationId: prior.operationId,
        workspaceRevision: record.workspace.revision,
        replay: true,
        state: record.workspace.state
      };
    }
    // A committed-but-unpushed forge/ branch only survives teardown via a
    // best-effort R2 snapshot (if enabled) or not at all — an idle reap or an
    // explicit destroy can otherwise discard real work with no trace. Refuse
    // unless the caller explicitly accepts the loss.
    if (record.workspace.hasUnpushedWork && !force) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: 'This workspace has committed changes that were never pushed. Push the forge/ branch first, or pass force to destroy anyway and accept the loss.',
        retryable: false,
        details: { workspaceId: record.workspace.id, branch: record.workspace.currentBranch }
      });
    }
    const operation = this.beginMutation(record, expectedRevision, idempotencyKey);
    record.workspace.state = 'destroying';
    record.workspace.updatedAt = new Date().toISOString();
    return {
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision,
      replay: false,
      state: record.workspace.state
    };
  }

  async completeDestroy(record: WorkspaceRuntimeRecord, cloneSource?: RepositoryCloneSource) {
    if (record.workspace.state === 'destroyed') {
      return { workspaceRevision: record.workspace.revision, replay: true };
    }
    if (record.workspace.state !== 'destroying') {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_CONFLICT',
        message: `Workspace cannot complete destruction from ${record.workspace.state}.`,
        retryable: false
      });
    }
    const handle = await this.providerFor(record).get(record.providerId);
    const git = await handle.exec({
      command: 'git status --porcelain=v2 --branch && git rev-parse HEAD && git branch --show-current',
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 200_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    const lines = git.stdout.split('\n');
    const currentCommit = lines.find((line) => /^[a-f0-9]{4,64}$/iu.test(line.trim()))?.trim();
    const currentBranch = lines.map((line) => line.trim()).filter(Boolean).at(-1);
    const dirty = lines.some((line) => line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('? '));
    if (git.exitCode !== 0 || dirty || currentCommit !== record.workspace.lastPushedCommit || currentBranch !== record.workspace.lastPushedBranch) {
      throw new ForgeError({
        code: 'FORGE_GIT_PUSH_BLOCKED',
        message: 'Forge refused teardown because the checked-out Git state changed after destroy was requested.',
        retryable: false,
        details: { currentCommit: currentCommit ?? null, currentBranch: currentBranch ?? null, dirty, lastPushedCommit: record.workspace.lastPushedCommit ?? null, lastPushedBranch: record.workspace.lastPushedBranch ?? null }
      });
    }
    await this.assertRemoteRef(record, handle, cloneSource);
    for (const preview of Object.values(record.previews)) {
      await handle.revokePort(preview.port).catch(() => undefined);
    }
    for (const processId of Object.keys(record.processes) as ProcessId[]) {
      await handle.stopProcess(processId).catch(() => undefined);
    }
    await this.providerFor(record).destroy(record.providerId);
    record.workspace.state = 'destroyed';
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = new Date().toISOString();
    record.processes = {};
    record.checks = {};
    record.previews = {};
    return { workspaceRevision: record.workspace.revision, replay: false };
  }

}
