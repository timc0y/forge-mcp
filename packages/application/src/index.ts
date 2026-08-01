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
  type TenantId,
  type Workspace,
  type WorkspaceId
} from '@forge/core';
import { assertCommandAllowed, nonInteractiveShellEnv } from '@forge/policy';
import type { ProjectDetection } from '@forge/project-detection';
import type {
  ExecInput,
  NetworkPolicyMode,
  SandboxHandle,
  SandboxProvider
} from '@forge/sandbox-core';
import { ExecutorMaterialization } from './executor-materialization.js';
import {
  ManagedProcesses,
  dependencyStateView,
  findActiveDependencyInstall,
  managedProcessStatus,
  observationalWaitNextStep,
  workspaceAllowedNextActions
} from './managed-processes.js';
import { RepositoryInspection, type RepositoryInspectionResult } from './repository-inspection.js';

export { parseProvisionProbe, type ProvisionProbe } from './executor-materialization.js';
export {
  dependencyStateView,
  managedProcessStatus,
  workspaceAllowedNextActions,
  LAZY_REQUESTED_NEXT_ACTIONS,
  OBSERVATIONAL_WAIT_MS,
  observationalWaitNextStep,
  durabilityNextStep,
  isDependencyInstallCommand,
  findActiveDependencyInstall,
  EXECUTOR_PROVISIONING_NEXT_STEP,
  type DependencyStateView
} from './managed-processes.js';
export {
  PROGRESS_STREAK_LIMIT,
  PROGRESS_ENTROPY_WINDOW,
  PROGRESS_ENTROPY_THRASH_BITS,
  PROGRESS_VERIFY_BUDGET,
  classifyToolProgress,
  durableFingerprint,
  extendWitnessChain,
  shannonEntropyBits,
  emptyProgressStreak,
  normalizeProgressStreak,
  phiFromReceipt,
  witnessIdFromReceipt,
  observeProgressEvent,
  progressGate,
  detectDurableWitness,
  progressPotentialView,
  type ToolProgressClass,
  type ProgressStreakState,
  type ProgressObservation,
  type ProgressGateDecision
} from './progress-potential.js';

export interface WorkspaceRuntimeRecord {
  workspace: Workspace;
  /** Whether the first lazy executor provision should bootstrap dependencies. */
  bootstrapRequested?: boolean;
  providerId: string;
  detection?: ProjectDetection;
  processes: Record<string, ManagedProcessEntry>;
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
  /** Commit currently materialized in the executor checkout. */
  executorCommit?: string;
  /** Two-phase gate held while forge_edit is mutating the GitHub branch. */
  githubEditInProgress?: { token: string; branch: string; intentHash: string; startedAt: string };
  /** Last completed edit handoff, retained to make recordGitHubCommit idempotent. */
  lastRecordedGitHubEdit?: { token: string; commit: string; branch: string };
  /** GitHub commit awaiting propagation into an already-loaded executor. */
  pendingRemoteCommit?: { commit: string; branch: string; recordedAt: string; invalidateDependencies: boolean };
  /** Set when the live checkout differs from the GitHub-backed workspace record. */
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
  /** Executor commit this process actually started against. */
  executorCommit?: string;
  /** Internal lifecycle receipt; says finalization ran, never that files are durable. */
  finalizedAt?: string;
  /** Artifact id of the persisted log output. */
  logArtifact?: ArtifactId;
}

export interface CreateWorkspaceInput {
  workspaceId?: WorkspaceId;
  /** Stable receipt supplied by transport layers that must survive a timed-out initialize RPC. */
  operationId?: OperationId;
  tenantId: TenantId;
  projectId: ProjectId;
  repository: RepositoryRef;
  /** Durable GitHub branch created before the optional executor is loaded. */
  agentBranch?: string;
  ref: string;
  credentialProfileId?: CredentialProfileId;
  runtimeProfile: 'node-22' | 'node-24' | 'python-3.13' | 'general-purpose';
  persistence: 'ephemeral';
  bootstrap: boolean;
  idempotencyKey: string;
  actor: ActorRef;
}

export interface RepositoryCloneSource {
  url: string;
  authorizationHeader?: string;
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

export class ForgeApplicationService {
  private readonly repositoryInspection = new RepositoryInspection();
  private readonly materialization: ExecutorMaterialization;
  private readonly managedProcesses: ManagedProcesses;

  constructor(private readonly provider: SandboxProvider) {
    this.materialization = new ExecutorMaterialization(provider);
    this.managedProcesses = new ManagedProcesses(
      provider,
      (record, options) => this.handle(record, options),
      (record, expectedRevision, idempotencyKey) => this.beginMutation(record, expectedRevision, idempotencyKey)
    );
  }

  initializeWorkspace(input: CreateWorkspaceInput): WorkspaceRuntimeRecord {
    assertRef(input.ref);
    const now = new Date().toISOString();
    const id = input.workspaceId ?? ids.workspace();
    const operationId = input.operationId ?? ids.operation();
    return {
      workspace: {
        id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        repository: input.repository,
        requestedRef: input.ref,
        ...(input.agentBranch ? { currentBranch: input.agentBranch } : {}),
        ...(input.credentialProfileId ? { credentialProfileId: input.credentialProfileId } : {}),
        state: 'requested',
        persistenceMode: input.persistence,
        runtimeProfile: input.runtimeProfile,
        provider: {
          // Provisional; provisionWorkspace() rewrites this before the sandbox
          // is created.
          kind: this.provider.kind,
          version: this.provider.version
        },
        revision: 1,
        createdBy: input.actor,
        createdAt: now,
        updatedAt: now
      },
      bootstrapRequested: input.bootstrap,
      providerId: sandboxProviderId(id),
      processes: {},
      previews: {},
      dependencyState: undefined,
      idempotency: {
        [input.idempotencyKey]: { operationId, revision: 1 }
      }
    };
  }

  async recoverCheckout(record: WorkspaceRuntimeRecord, cloneSource?: RepositoryCloneSource): Promise<void> {
    return this.materialization.recover(record, cloneSource);
  }

  async syncRemoteCommit(
    record: WorkspaceRuntimeRecord,
    commit: string,
    branch: string,
    invalidateDependencies: boolean,
    cloneSource?: RepositoryCloneSource
  ): Promise<void> {
    return this.materialization.syncRemoteCommit(record, commit, branch, invalidateDependencies, cloneSource);
  }

  async provisionWorkspace(
    record: WorkspaceRuntimeRecord,
    bootstrap: boolean,
    onStateChange: (record: WorkspaceRuntimeRecord) => Promise<void> = async () => undefined,
    cloneSource?: RepositoryCloneSource
  ): Promise<WorkspaceRuntimeRecord> {
    return this.materialization.provision(record, bootstrap, onStateChange, cloneSource);
  }

  recordProvisioningFailure(record: WorkspaceRuntimeRecord, error: unknown): ForgeError {
    return this.materialization.recordFailure(record, error);
  }

  markProvisioningExhausted(record: WorkspaceRuntimeRecord): WorkspaceRuntimeRecord {
    return this.materialization.markExhausted(record);
  }

  /** Active mutations cannot be interrupted by executor recovery. */
  private hasActiveMutators(record: WorkspaceRuntimeRecord): boolean {
    return Object.values(record.processes).some(
      (entry) =>
        entry.mutatesFilesystem &&
        !entry.completedAt
    );
  }

  private async handle(
    record: WorkspaceRuntimeRecord,
    options: { allowRecreate?: boolean } = {}
  ): Promise<SandboxHandle> {
    const allowRecreate = options.allowRecreate !== false;
    if (
      record.workspace.state === 'destroyed' ||
      record.workspace.state === 'destroying'
    ) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_NOT_READY',
        message:
          'This workspace is destroyed or destroying. GitHub commits on its forge/* branch are kept. Call forge_workspace_create with the same repository (and ref pointing at that forge/* branch if you still need it); do not retry tools against the old workspace_id.',
        retryable: false,
        details: {
          state: record.workspace.state,
          next_step:
            'Call forge_workspace_create for the same repository; do not retry tools against the old workspace_id.'
        }
      });
    }
    if (!['ready', 'busy'].includes(record.workspace.state)) {
      // "Workspace is failed." on its own is a dead end, and an agent facing a
      // dead end does not stop — it invents a cause and a way round. Two
      // separate agents met exactly this message, concluded the GitHub App had
      // read-only access (it has contents:write), and announced they were
      // switching to a "read-only workspace" that does not exist. The reason
      // was on the record the whole time and this throw discarded it.
      const failure = record.workspace.failure;
      const state = record.workspace.state;
      const retryable = state === 'provisioning' || state === 'requested';
      const nextStep = retryable
        ? 'It is still starting or paused. Retry the same call shortly; do not create a second workspace.'
        : 'This is a workspace provisioning fault, not a repository permission problem, and there is no read-only or degraded mode to fall back to. Start a new workspace with forge_workspace_create.';
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_NOT_READY',
        message: `Workspace is ${state}.${failure ? ` It failed at the ${failure.stage} stage: ${failure.message}` : ''} ${nextStep}`,
        retryable,
        details: {
          state,
          next_step: nextStep,
          ...(failure ? { failure_stage: failure.stage, failure_code: failure.code } : {})
        }
      });
    }
    const handle = await this.provider.get(record.providerId);
    let inspection = await this.repositoryInspection.inspect(handle, record);
    if (inspection.state === 'unavailable') {
      // A Durable Object reset mid-command often leaves process bookkeeping and
      // the sandbox briefly disagreeing. Adopt/reap tracked processes and retry
      // before failing closed as opaque UNKNOWN.
      inspection = await this.recoverUnavailableInspection(record, handle, inspection);
    }
    if (inspection.state === 'matches') return handle;
    if (inspection.state === 'diverged') {
      this.repositoryInspection.noteDivergence(record, inspection);
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
        }
      });
    }
    if (inspection.state === 'mount_missing') {
      // Never replace an executor underneath a running mutating command.
      // Completed command files are intentionally ephemeral and do not block
      // recovery from the GitHub-backed base checkout.
      if (!allowRecreate || this.hasActiveMutators(record)) {
        throw new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'Workspace mount is missing, but Forge will not replace the executor while a managed mutating process is active. Wait for or stop the process, then retry.',
          retryable: true,
          details: {
            workspaceId: record.workspace.id,
            allowRecreate,
            activeMutators: Object.entries(record.processes)
              .filter(([, entry]) => entry.mutatesFilesystem && !entry.completedAt)
              .map(([id, entry]) => ({ id, command: entry.command, completedAt: entry.completedAt ?? null }))
          }
        });
      }
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: 'The executor filesystem mount disappeared. Destroy and recreate the workspace, then retry the execution tool.',
        retryable: true,
        details: { workspaceId: record.workspace.id }
      });
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
   * Reconcile recorded process entries with the provider and mark finished
   * processes complete.
   */
  async syncProcessLifecycle(record: WorkspaceRuntimeRecord, options: { finalize?: boolean } = {}) {
    return this.managedProcesses.syncProcessLifecycle(record, options);
  }

  /**
   * Confirm the checkout through the same fail-closed inspection path used by
   * executor operations. Ambiguous or divergent state is never overwritten.
   */
  async assertCheckoutPresent(record: WorkspaceRuntimeRecord): Promise<void> {
    if (!['ready', 'busy'].includes(record.workspace.state)) return;
    await this.repositoryInspection.assertCheckoutPresent(
      record,
      await this.provider.get(record.providerId)
    );
  }

  private beginMutation(
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
            head: record.executorCommit ?? record.workspace.currentCommit,
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
              : observationalWaitNextStep(processId),
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
          head: record.executorCommit ?? record.workspace.currentCommit,
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
      head: record.executorCommit ?? record.workspace.currentCommit,
      baseCommit: record.workspace.baseCommit,
      classification: decision.classification,
      operationId,
      ...(operationId && input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey, replayed: false, originalOperationId: operationId }
        : {}),
      workspaceRevision: record.workspace.revision
    };
  }

  async startProcess(record: WorkspaceRuntimeRecord, input: { command: string; cwd: string; environment?: Record<string, string>; networkPolicy: NetworkPolicyMode; idempotencyKey: string; expectedRevision?: number; approved?: boolean }) {
    return this.managedProcesses.startProcess(record, input);
  }

  async processLogs(record: WorkspaceRuntimeRecord, processId: ProcessId, cursor?: string) {
    return this.managedProcesses.processLogs(record, processId, cursor);
  }

  async processGet(record: WorkspaceRuntimeRecord, processId: ProcessId) {
    return this.managedProcesses.processGet(record, processId);
  }

  async processList(record: WorkspaceRuntimeRecord) {
    return this.managedProcesses.processList(record);
  }

  async operationGet(record: WorkspaceRuntimeRecord, operationId: OperationId) {
    return this.managedProcesses.operationGet(record, operationId);
  }

  async processWait(record: WorkspaceRuntimeRecord, processId: ProcessId, timeoutMs?: number) {
    return this.managedProcesses.processWait(record, processId, timeoutMs);
  }

  async processCancel(record: WorkspaceRuntimeRecord, processId: ProcessId, expectedRevision: number | undefined, idempotencyKey: string) {
    return this.managedProcesses.processCancel(record, processId, expectedRevision, idempotencyKey);
  }

  async stopProcess(record: WorkspaceRuntimeRecord, processId: ProcessId, expectedRevision: number | undefined, idempotencyKey: string) {
    return this.managedProcesses.stopProcess(record, processId, expectedRevision, idempotencyKey);
  }

  async reconcileGitState(record: WorkspaceRuntimeRecord): Promise<boolean> {
    const handle = await this.provider.get(record.providerId);
    let inspection = await this.repositoryInspection.inspect(handle, record);
    if (inspection.state === 'unavailable') {
      inspection = await this.recoverUnavailableInspection(record, handle, inspection);
    }
    if (inspection.state === 'mount_missing') {
      if (this.hasActiveMutators(record)) {
        throw new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'Workspace mount is missing, but Forge will not replace the executor while a managed mutating process is still active. Wait for or stop that process, then retry.',
          retryable: true,
          details: { workspaceId: record.workspace.id }
        });
      }
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: 'The executor filesystem mount disappeared. Destroy and recreate the workspace, then retry the execution tool.',
        retryable: true,
        details: { workspaceId: record.workspace.id }
      });
    }
    if (inspection.state === 'diverged') {
      this.repositoryInspection.noteDivergence(record, inspection);
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
    previous: RepositoryInspectionResult
  ): Promise<RepositoryInspectionResult> {
    await this.managedProcesses.adoptOrReap(record, handle);
    // Give the provider a brief moment after DO/storage churn before re-probing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const retry = await this.repositoryInspection.inspect(handle, record);
    if (retry.state !== 'unavailable') return retry;
    return {
      ...retry,
      diagnostic: retry.diagnostic ?? previous.diagnostic ?? { code: 'UNKNOWN', operation: 'recover_unavailable_inspection' }
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
    const activeInstall = findActiveDependencyInstall(record);
    if (activeInstall && (!prior?.processId || prior.processId !== activeInstall.processId)) {
      return {
        started: true,
        success: false,
        status: 'running' as const,
        workspaceId: record.workspace.id,
        processId: activeInstall.processId,
        managedProcess: true,
        command: activeInstall.command,
        dependencyState: dependencyStateView(record.dependencyState),
        reusedActiveProcess: true,
        operationId: prior?.operationId ?? record.idempotency[input.idempotencyKey]?.operationId ?? ids.operation(),
        workspaceRevision: record.workspace.revision,
        allowedNextActions: ['forge_process_wait', 'forge_process_logs', 'forge_process_list'],
        next_step: observationalWaitNextStep(activeInstall.processId, { alreadyRunning: true })
      };
    }

    const handle = await this.handle(record, { allowRecreate: false });

    // Ensure the package manager is available.
    await this.materialization.preparePackageManager(handle);

    // Detect the project.
    const detection = record.detection ?? await (await import('@forge/project-detection')).detectProject(handle);
    // A GitHub edit to a manifest/lockfile invalidates project detection during
    // executor resync. Persist the fresh result so preview/dev-server workflows
    // do not remain permanently unable to find a command after reinstalling.
    record.detection = detection;

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
          allowedNextActions: ['forge_deps_install', 'forge_workspace_get']
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
      remotePersisted: false,
      executorFilesystem: 'ephemeral',
      replayed: 'replay' in started && started.replay === true,
      idempotencyKey: input.idempotencyKey,
      originalOperationId: started.operationId,
      operationId: started.operationId,
      workspaceRevision: record.workspace.revision,
      stderr: logs.data.slice(-2_000),
      stdout: logs.data.slice(0, 1_000),
      allowedNextActions: success
        ? ['forge_shell', 'forge_workspace_get']
        : ['forge_deps_install', 'forge_workspace_get'],
      next_step: success
        ? 'Dependencies are usable. Continue with forge_shell / validation.'
        : 'Dependency install failed. Inspect logs with forge_process_logs, then retry with a new idempotency key only if needed.'
    };
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
        message:
          'The preview process was not found. Call forge_process_list and pass a running process_id, or call forge_preview without preview_id so Forge starts the app first.',
        retryable: false,
        details: { processId: input.processId, allowedNextActions: ['forge_process_list', 'forge_preview'] }
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
    return this.repositoryInspection.status(record, await this.handle(record));
  }

  requestDestroy(
    record: WorkspaceRuntimeRecord,
    expectedRevision: number | undefined,
    idempotencyKey: string
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

  async completeDestroy(record: WorkspaceRuntimeRecord) {
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
    const handle = await this.provider.get(record.providerId).catch(() => null);
    if (handle) {
      for (const preview of Object.values(record.previews)) {
        await handle.revokePort(preview.port).catch(() => undefined);
      }
      for (const processId of Object.keys(record.processes) as ProcessId[]) {
        await handle.stopProcess(processId).catch(() => undefined);
      }
    }
    await this.provider.destroy(record.providerId).catch(() => undefined);
    record.workspace.state = 'destroyed';
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = new Date().toISOString();
    record.processes = {};
    record.previews = {};
    record.executorCommit = undefined;
    return { workspaceRevision: record.workspace.revision, replay: false };
  }

}
