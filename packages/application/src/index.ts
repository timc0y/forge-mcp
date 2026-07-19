import {
  ForgeError,
  ids,
  nextRevision,
  type ActorRef,
  type OperationId,
  type ProcessId,
  type ProjectId,
  type RepositoryRef,
  type TenantId,
  type Workspace,
  type WorkspaceFailureDetails,
  type WorkspaceId
} from '@forge/core';
import { assertCommandAllowed, classifyCommand } from '@forge/policy';
import { detectProject, type ProjectDetection } from '@forge/project-detection';
import type {
  ExecInput,
  FileReadInput,
  FileWriteInput,
  ListFilesInput,
  NetworkPolicyMode,
  PatchInput,
  SandboxHandle,
  SandboxProvider
} from '@forge/sandbox-core';

export interface WorkspaceRuntimeRecord {
  workspace: Workspace;
  providerId: string;
  detection?: ProjectDetection;
  processes: Record<string, { command: string; port?: number }>;
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
  idempotency: Record<string, { operationId: OperationId; revision: number }>;
}

export interface CreateWorkspaceInput {
  workspaceId?: WorkspaceId;
  tenantId: TenantId;
  projectId: ProjectId;
  repository: RepositoryRef;
  ref: string;
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
  if (!ref || ref.length > 255 || /[\s~^:?*[\\]/.test(ref) || ref.includes('..')) {
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
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
      previews: {},
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
      networkPolicy: 'package_install'
    }).catch(() => undefined);
  }

  // Clone the repository checkout into /workspace/repo. Shared by first-time
  // provisioning and by in-place checkout recovery.
  private async checkoutRepository(
    record: WorkspaceRuntimeRecord,
    handle: SandboxHandle,
    cloneSource?: RepositoryCloneSource
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
      command: `git clone --depth 1 --branch ${quoted(record.workspace.requestedRef)} ${quoted(source.url)} /workspace/repo`,
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
   */
  async recoverCheckout(
    record: WorkspaceRuntimeRecord,
    cloneSource?: RepositoryCloneSource
  ): Promise<void> {
    const handle = await this.providerFor(record).get(record.providerId);
    await handle.exec({
      command: 'rm -rf /workspace/repo',
      cwd: '/workspace',
      timeoutMs: 30_000,
      outputLimitBytes: 1_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch(() => undefined);
    await this.checkoutRepository(record, handle, cloneSource);
    await this.preparePackageManager(handle);
    const checkedAt = new Date().toISOString();
    record.workspace.state = 'ready';
    record.workspace.checkout = { healthy: true, checkedAt };
    record.workspace.failure = undefined;
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = checkedAt;
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
      const handle = await provider.create({
        providerId: record.providerId,
        runtimeProfile: record.workspace.runtimeProfile as CreateWorkspaceInput['runtimeProfile'],
        labels: {
          workspaceId: record.workspace.id,
          tenantId: record.workspace.tenantId,
          repository: repositorySlug(record.workspace.repository)
        },
        idleTimeout: '90s'
      });

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
      const detection = await detectProject(handle);
      record.detection = detection;

      // Per-repo dependency cache: when this was a cold provision (no
      // per-workspace snapshot restored) and the deps cache is wired, try to warm
      // node_modules from the shared, content-keyed cache before installing. A hit
      // turns the install into a fast --prefer-offline verify; a miss populates the
      // cache after a successful install. Best-effort — never blocks provisioning.
      let depsRestored = false;
      let lockfileHash: string | null = null;
      if (bootstrap && detection.installCommand && depsCache && !usedSnapshot) {
        const lockfile = lockfileFor(detection.packageManager);
        if (lockfile) {
          try {
            const hashed = await handle.exec({
              command: `sha256sum ${quoted(lockfile)} | cut -d' ' -f1`,
              cwd: '/workspace/repo',
              timeoutMs: 30_000,
              outputLimitBytes: 1_000,
              sessionId: 'system',
              networkPolicy: 'deny_all'
            });
            const out = hashed.stdout.trim();
            if (hashed.exitCode === 0 && /^[a-f0-9]{64}$/.test(out)) {
              lockfileHash = out;
              depsRestored = await depsCache.restore(out).catch(() => false);
            }
          } catch {
            // fall through to a normal install
          }
        }
      }

      if (bootstrap && detection.installCommand) {
        const install = await handle.exec({
          command: detection.installCommand,
          cwd: '/workspace/repo',
          timeoutMs: 600_000,
          outputLimitBytes: 500_000,
          sessionId: 'system',
          networkPolicy: 'package_install'
        });
        if (install.exitCode !== 0) {
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: 'Project bootstrap failed.',
            retryable: false,
            details: {
              stage: 'bootstrap',
              phase: 'dependency_install',
              command: detection.installCommand,
              packageManager: detection.packageManager,
              exitCode: install.exitCode,
              durationMs: install.durationMs,
              truncated: install.truncated,
              stderr: install.stderr.slice(0, 4_000),
              stdout: install.stdout.slice(0, 2_000)
            }
          });
        }
        // Cache miss: install just built node_modules from scratch — hand it to
        // the shared cache so the next workspace of this repo+lockfile skips it.
        if (depsCache && !depsRestored && lockfileHash) {
          depsCache.populate(lockfileHash);
        }
      }

      const gitState = await handle.exec({
        command: 'git rev-parse HEAD && git branch --show-current',
        cwd: '/workspace/repo',
        timeoutMs: 30_000,
        outputLimitBytes: 10_000,
        sessionId: 'system',
        networkPolicy: 'deny_all'
      });
      const [currentCommit = '', currentBranch = ''] = gitState.stdout.trim().split('\n');
      record.workspace.currentCommit = currentCommit;
      record.workspace.currentBranch = currentBranch || record.workspace.requestedRef;
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

  async handle(record: WorkspaceRuntimeRecord): Promise<SandboxHandle> {
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
    return this.providerFor(record).get(record.providerId);
  }

  /**
   * Confirm the repository checkout is still present before a repository-scoped
   * operation runs. A `ready` workspace whose `/workspace/repo` mount has
   * vanished is transitioned to `failed` with a clear checkout failure instead
   * of letting downstream commands report a bare "No such file or directory".
   * Returns silently when the workspace is not in a repo-usable state (the
   * normal state gate in {@link handle} will produce the right error) and
   * throws {@link ForgeError} `FORGE_WORKSPACE_NOT_READY` when the checkout is
   * gone. On success it refreshes `workspace.checkout` health in place.
   */
  async assertCheckoutPresent(record: WorkspaceRuntimeRecord): Promise<void> {
    if (!['ready', 'busy'].includes(record.workspace.state)) return;
    const handle = await this.providerFor(record).get(record.providerId);
    const probe = await handle.exec({
      command: 'test -d /workspace/repo/.git && echo forge_checkout_present || echo forge_checkout_missing',
      cwd: '/workspace',
      timeoutMs: 10_000,
      outputLimitBytes: 1_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    const checkedAt = new Date().toISOString();
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
  ): { operationId: OperationId; replay: boolean } {
    const prior = record.idempotency[idempotencyKey];
    if (prior) return { operationId: prior.operationId, replay: true };
    const operationId = ids.operation();
    record.workspace.revision = nextRevision(record.workspace.revision, expectedRevision);
    record.workspace.updatedAt = new Date().toISOString();
    record.idempotency[idempotencyKey] = {
      operationId,
      revision: record.workspace.revision
    };
    return { operationId, replay: false };
  }

  async tree(record: WorkspaceRuntimeRecord, input: ListFilesInput) {
    return (await this.handle(record)).listFiles(input);
  }

  async read(record: WorkspaceRuntimeRecord, input: FileReadInput) {
    return (await this.handle(record)).readFile(input);
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
    const value = await (await this.handle(record)).applyPatch(input);
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
    record.workspace.hasUnpushedWork = true;
    return {
      value,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision
    };
  }

  // Full-file create/overwrite. Far easier for a headless agent than crafting a
  // unified diff, and conflict-safe when `expectedSha256` is supplied (from a
  // prior forge_files_read).
  async write(
    record: WorkspaceRuntimeRecord,
    input: FileWriteInput,
    expectedRevision: number | undefined,
    idempotencyKey: string
  ) {
    const operation = this.beginMutation(record, expectedRevision, idempotencyKey);
    if (operation.replay) {
      return { replay: true, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
    }
    try {
      const value = await (await this.handle(record)).writeFile(input);
      record.workspace.hasUnpushedWork = true;
      return { value, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
    } catch (error) {
      if (error instanceof Error && error.message === 'FILE_HASH_CONFLICT') {
        throw new ForgeError({
          code: 'FORGE_FILE_CONFLICT',
          message: 'The file changed since it was read (expected_sha256 no longer matches). Re-read it and retry with the new hash.',
          retryable: false,
          operationId: operation.operationId
        });
      }
      throw error;
    }
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
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
          durationMs: 0,
          artifactRefs: [],
          replay: true,
          operationId,
          workspaceRevision: record.workspace.revision
        };
      }
    }
    const result = await (await this.handle(record)).exec({
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      environment: input.environment,
      stdin: input.stdin,
      outputLimitBytes: input.outputLimitBytes,
      sessionId: input.sessionId ?? 'agent-default',
      networkPolicy: input.networkPolicy
    });
    return {
      ...result,
      classification: decision.classification,
      operationId,
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
    }
  ) {
    const decision = classifyCommand(input.command, input.networkPolicy);
    if (
      decision.classification === 'dependency_install' ||
      decision.approvalRequired
    ) {
      throw new ForgeError({
        code: 'FORGE_APPROVAL_REQUIRED',
        message: 'This background process requires approval.',
        retryable: false,
        details: { classification: decision.classification }
      });
    }
    assertCommandAllowed(input.command, input.networkPolicy, false);
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
    const processId = ids.process();
    const value = await (await this.handle(record)).startProcess({
      processId,
      command: input.command,
      cwd: input.cwd,
      environment: input.environment,
      sessionId: 'dev-server',
      networkPolicy: input.networkPolicy,
      autoCleanup: false
    });
    record.processes[processId] = { command: input.command };
    return {
      value,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision
    };
  }

  async processLogs(
    record: WorkspaceRuntimeRecord,
    processId: ProcessId,
    cursor?: string
  ) {
    return (await this.handle(record)).readProcessLogs({
      processId,
      cursor,
      limitBytes: 200_000
    });
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
    return {
      raw: result.stdout,
      clean: !result.stdout
        .split('\n')
        .some(
          (line) =>
            line.startsWith('1 ') ||
            line.startsWith('2 ') ||
            line.startsWith('? ')
        )
    };
  }

  async gitDiff(record: WorkspaceRuntimeRecord, staged = false) {
    return this.exec(record, {
      command: staged
        ? 'git diff --cached --no-ext-diff'
        : 'git diff --no-ext-diff',
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
      outputLimitBytes: 500_000,
      networkPolicy: 'deny_all'
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
    const result = await (await this.handle(record)).exec({
      command: `git switch -c ${quoted(branch)}`,
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 50_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0) throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Forge could not create the branch.', retryable: false });
    record.workspace.currentBranch = branch;
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
    // Fuse stage + commit + rev-parse into a single container round-trip. The
    // `&&` chain preserves ordering and short-circuits, so a failed stage still
    // surfaces before the commit runs. HEAD is the last line of stdout.
    const commit = await handle.exec({
      command: `sh -c ${quoted(
        `git add -- ${paths.map(quoted).join(' ')} && git commit -m ${quoted(input.message.trim())} && git rev-parse HEAD`
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
    record.workspace.currentCommit = commit.stdout.trim().split('\n').pop()?.trim() ?? '';
    record.workspace.hasUnpushedWork = true;
    return { commit: record.workspace.currentCommit, branch: record.workspace.currentBranch, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
  }

  async gitOutgoingDiff(record: WorkspaceRuntimeRecord, base: string) {
    assertRef(base);
    const result = await (await this.handle(record)).exec({
      command: `git diff --no-ext-diff --binary ${quoted(base)}...HEAD`,
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 1_000_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0) throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Forge could not calculate the outgoing change.', retryable: false });
    return { diff: result.stdout, diffHash: await sha256Text(result.stdout), branch: record.workspace.currentBranch, base };
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
    } finally {
      await handle.exec({ command: `rm -f ${quoted(configPath)}`, cwd: '/workspace', timeoutMs: 10_000, outputLimitBytes: 1_000, sessionId: 'system', networkPolicy: 'deny_all' }).catch(() => undefined);
    }
    // Work is now pushed to GitHub — safe for the reaper to reclaim on idle.
    record.workspace.hasUnpushedWork = false;
    return { branch: input.branch, commit: record.workspace.currentCommit, diffHash: outgoing.diffHash, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
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
    const handle = await this.providerFor(record).get(record.providerId);
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
    record.previews = {};
    return { workspaceRevision: record.workspace.revision, replay: false };
  }

}
