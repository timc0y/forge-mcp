import { ForgeError, nextRevision, type RepositoryRef, type WorkspaceFailureDetails } from '@forge/core';
import { nonInteractiveShellEnv } from '@forge/policy';
import { DETECTION_SCRIPT, parseDetection, type ProjectDetection } from '@forge/project-detection';
import type { SandboxHandle, SandboxProvider } from '@forge/sandbox-core';

import type { CreateWorkspaceInput, RepositoryCloneSource, WorkspaceRuntimeRecord } from './index.js';

const PROVISION_PROBE_COMMAND = [
  'echo ===FORGE_HEAD===',
  'git rev-parse HEAD',
  'echo ===FORGE_BRANCH===',
  'git branch --show-current',
  'echo ===FORGE_DETECTION===',
  DETECTION_SCRIPT
].join('\n');

const PROVIDER_CREATE_TIMEOUT_MS = 120_000;

export interface ProvisionProbe {
  head: string;
  branch: string;
  detection: ProjectDetection;
}

export function parseProvisionProbe(stdout: string): ProvisionProbe {
  const markers = ['===FORGE_HEAD===', '===FORGE_BRANCH===', '===FORGE_DETECTION==='];
  const section = (name: string): string => {
    const start = stdout.indexOf(name);
    if (start === -1) return '';
    const from = start + name.length;
    let end = stdout.length;
    for (const marker of markers) {
      const index = stdout.indexOf(marker, from);
      if (index !== -1 && index < end) end = index;
    }
    return stdout.slice(from, end).trim();
  };
  return {
    head: section('===FORGE_HEAD==='),
    branch: section('===FORGE_BRANCH==='),
    detection: parseDetection(section('===FORGE_DETECTION==='))
  };
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

function quoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Cleanup is best-effort and must not mask the timeout.
      }
      reject(new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: 'Workspace provisioning timed out.',
        retryable: true,
        details: { stage: 'provision', phase, timeoutMs }
      }));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Materializes disposable executors from the GitHub-backed workspace record.
 * Executor files never become durable repository edits through this module.
 */
export class ExecutorMaterialization {
  constructor(private readonly provider: SandboxProvider) {}

  async preparePackageManager(handle: SandboxHandle): Promise<void> {
    await handle.exec({
      command: 'command -v pnpm >/dev/null 2>&1 || corepack prepare pnpm@9 --activate 2>/dev/null || npm install -g pnpm@9',
      cwd: '/workspace',
      timeoutMs: 120_000,
      outputLimitBytes: 20_000,
      sessionId: 'system',
      networkPolicy: 'package_install',
      environment: nonInteractiveShellEnv()
    }).catch(() => undefined);
  }

  private defaultCloneSource(record: WorkspaceRuntimeRecord): RepositoryCloneSource {
    return { url: `https://github.com/${repositorySlug(record.workspace.repository)}.git` };
  }

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
      command: `git clone --depth 1 --no-tags --branch ${quoted(ref ?? record.workspace.currentBranch ?? record.workspace.requestedRef)} ${quoted(source.url)} /workspace/repo`,
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

  async recover(record: WorkspaceRuntimeRecord, cloneSource?: RepositoryCloneSource): Promise<void> {
    const recoverRef = record.workspace.currentBranch ?? record.workspace.requestedRef;
    const handle = await this.provider.get(record.providerId);
    await handle.exec({
      command: 'rm -rf /workspace/repo',
      cwd: '/workspace',
      timeoutMs: 30_000,
      outputLimitBytes: 1_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch(() => undefined);
    try {
      await this.checkoutRepository(record, handle, cloneSource, recoverRef);
    } catch (cloneError) {
      if (recoverRef === record.workspace.requestedRef) throw cloneError;
      await this.checkoutRepository(record, handle, cloneSource, record.workspace.requestedRef);
    }
    const recoveredIdentity = await handle.exec({
      command: 'git rev-parse HEAD',
      cwd: '/workspace/repo',
      timeoutMs: 10_000,
      outputLimitBytes: 1_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    const recoveredCommit = recoveredIdentity.stdout.trim();
    if (recoveredIdentity.exitCode !== 0 || !/^[0-9a-f]{40}$/iu.test(recoveredCommit)) {
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: 'The recovered executor checkout did not expose a valid Git commit.',
        retryable: true,
        details: { stage: 'recover_checkout_identity' }
      });
    }
    record.executorCommit = recoveredCommit;
    await this.preparePackageManager(handle);
    const checkedAt = new Date().toISOString();
    record.workspace.state = 'ready';
    record.workspace.checkout = { healthy: true, checkedAt };
    record.workspace.failure = undefined;
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = checkedAt;
  }

  /**
   * Advance an already-loaded checkout to the commit accepted by GitHub.
   *
   * A hard reset deliberately discards tracked executor-only edits: forge_edit
   * is the sole durable code-writing interface. Untracked dependency/build
   * caches stay in place, keeping this much cheaper than re-cloning.
   */
  async syncRemoteCommit(
    record: WorkspaceRuntimeRecord,
    commit: string,
    branch: string,
    invalidateDependencies: boolean,
    cloneSource?: RepositoryCloneSource
  ): Promise<void> {
    const handle = await this.provider.get(record.providerId);
    const source = cloneSource ?? this.defaultCloneSource(record);
    const gitConfigPath = `/workspace/tmp/gitconfig-${record.workspace.id}`;
    if (source.authorizationHeader) {
      await handle.writeFile({
        path: gitConfigPath,
        content: `[http]\n\textraHeader = ${source.authorizationHeader}\n`
      });
    }
    try {
      const synced = await handle.exec({
        command: `git fetch --no-tags --depth 1 origin ${quoted(branch)} && git reset --hard ${quoted(commit)} && test "$(git rev-parse HEAD)" = ${quoted(commit)}`,
        cwd: '/workspace/repo',
        timeoutMs: 120_000,
        outputLimitBytes: 100_000,
        sessionId: 'system',
        networkPolicy: 'development',
        environment: source.authorizationHeader
          ? { GIT_CONFIG_GLOBAL: gitConfigPath, GIT_TERMINAL_PROMPT: '0' }
          : { GIT_TERMINAL_PROMPT: '0' }
      });
      if (synced.exitCode !== 0 || synced.truncated) {
        throw new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'GitHub accepted the edit, but the loaded executor could not advance to that commit. Retry the next execution tool; the GitHub commit is already durable.',
          retryable: true,
          details: {
            stage: 'executor_resync',
            commit,
            branch,
            exitCode: synced.exitCode,
            stderr: synced.stderr.slice(0, 2_000)
          }
        });
      }
    } finally {
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
    }
    const syncedAt = new Date().toISOString();
    record.workspace.currentCommit = commit;
    record.workspace.currentBranch = branch;
    record.executorCommit = commit;
    record.workspace.checkout = { healthy: true, checkedAt: syncedAt };
    record.workspace.updatedAt = syncedAt;
    if (invalidateDependencies) {
      record.dependencyState = undefined;
      record.detection = undefined;
    }
    record.lastGitDivergence = undefined;
  }

  async provision(
    record: WorkspaceRuntimeRecord,
    bootstrap: boolean,
    onStateChange: (record: WorkspaceRuntimeRecord) => Promise<void> = async () => undefined,
    cloneSource?: RepositoryCloneSource
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
      const provider = this.provider;
      record.workspace.provider = { kind: provider.kind, version: provider.version };
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
      const handle = await withTimeout(createPromise, PROVIDER_CREATE_TIMEOUT_MS, 'container_create', () => {
        console.warn('forge_provision_create_timeout_orphan', {
          workspaceId: record.workspace.id,
          providerId: record.providerId,
          provider: provider.kind
        });
        createPromise.then(
          () => provider.destroy(record.providerId).catch(() => undefined),
          () => undefined
        ).catch(() => undefined);
        provider.destroy(record.providerId).catch(() => undefined);
      });

      await Promise.all([
        this.checkoutRepository(record, handle, cloneSource ?? this.defaultCloneSource(record)),
        this.preparePackageManager(handle)
      ]);

      record.workspace.state = 'bootstrapping';
      record.workspace.revision = nextRevision(record.workspace.revision);
      record.workspace.updatedAt = new Date().toISOString();
      await onStateChange(record);

      const probe = await handle.exec({
        command: PROVISION_PROBE_COMMAND,
        cwd: '/workspace/repo',
        timeoutMs: 30_000,
        outputLimitBytes: 100_000,
        sessionId: 'system',
        networkPolicy: 'deny_all'
      });
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

      if (bootstrap && detection.installCommand) {
        const runInstall = (command: string) => handle.exec({
          command,
          cwd: '/workspace/repo',
          timeoutMs: 600_000,
          outputLimitBytes: 500_000,
          sessionId: 'system',
          networkPolicy: 'package_install'
        });
        let install = await runInstall(detection.installCommand);
        if (install.exitCode !== 0 && detection.installFallbackCommand) {
          install = await runInstall(detection.installFallbackCommand);
        }
        if (install.exitCode !== 0) {
          record.workspace.bootstrapWarning = {
            phase: 'dependency_install',
            message: 'Dependency install did not complete; the workspace is usable but node_modules may be incomplete.',
            detail: (install.stderr || install.stdout || '').slice(0, 2_000)
          };
        }
      }

      record.workspace.currentCommit = parsedProbe.head;
      record.executorCommit = parsedProbe.head;
      record.workspace.currentBranch = parsedProbe.branch || undefined;
      record.workspace.baseCommit = parsedProbe.head;
      record.workspace.initialHeadCommit = parsedProbe.head;
      await handle.writeFile({
        path: '/workspace/forge/workspace-id',
        content: `${record.workspace.id}\n`
      });
      record.workspace.state = 'ready';
      record.workspace.failure = undefined;
      record.workspace.revision = nextRevision(record.workspace.revision);
      record.workspace.updatedAt = new Date().toISOString();
      await onStateChange(record);
      return record;
    } catch (error) {
      await this.provider.destroy(record.providerId).catch(() => undefined);
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
      this.recordFailure(record, forgeError);
      await onStateChange(record);
      throw forgeError;
    }
  }

  recordFailure(record: WorkspaceRuntimeRecord, error: unknown): ForgeError {
    const forgeError = error instanceof ForgeError
      ? error
      : new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'Workspace provisioning setup failed for an unknown reason. Retry the first execution tool; no command ran.',
          retryable: true,
          details: { stage: 'provision_setup', cause: error instanceof Error ? error.name : 'unknown' }
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
    return forgeError;
  }

  markExhausted(record: WorkspaceRuntimeRecord): WorkspaceRuntimeRecord {
    if (
      record.workspace.state === 'ready' ||
      record.workspace.state === 'destroying' ||
      record.workspace.state === 'destroyed' ||
      (record.workspace.state === 'failed' && record.workspace.failure?.retryable === false)
    ) return record;

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
}
