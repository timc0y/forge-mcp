import {
  ForgeError,
  ids,
  nextRevision,
  type ActorRef,
  type CredentialProfileId,
  type OperationId,
  type ProcessId,
  type ProjectId,
  type RepositoryRef,
  type TenantId,
  type Workspace,
  type WorkspaceId
} from '@forge/core';
import { assertCommandAllowed, classifyCommand } from '@forge/policy';
import { detectProject, type ProjectDetection } from '@forge/project-detection';
import type {
  CreateSandboxInput,
  ExecInput,
  FileReadInput,
  FileWriteInput,
  ListFilesInput,
  NetworkPolicyMode,
  PatchInput,
  SandboxHandle,
  SandboxProvider
} from '@forge/sandbox-core';
import type { SnapshotRef } from '@forge/sandbox-core';

export interface WorkspaceRuntimeRecord {
  workspace: Workspace;
  providerId: string;
  detection?: ProjectDetection;
  processes: Record<string, { command: string; port?: number }>;
  checks: Record<string, { name: string; command: string; startedAt: string; commit?: string }>;
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
}

interface WorkspaceCheckpoint extends SnapshotRef {
  // Optional only for checkpoints persisted before manifest-backed recovery.
  // They are upgraded after a confirmed mount-loss restore, never trusted
  // for a destructive restore while a live workspace exists.
  manifest?: {
    commit: string;
    branch?: string;
    /** Hash of every file, directory, mode and symlink captured under /workspace. */
    workspaceHash: string;
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
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class ForgeApplicationService {
  constructor(private readonly sandboxProvider: SandboxProvider) {}

  private restoreInput(record: WorkspaceRuntimeRecord): CreateSandboxInput {
    return {
      providerId: record.providerId,
      runtimeProfile: record.workspace.runtimeProfile as CreateWorkspaceInput['runtimeProfile'],
      labels: {
        workspaceId: record.workspace.id,
        tenantId: record.workspace.tenantId,
        repository: repositorySlug(record.workspace.repository)
      },
      idleTimeout: '90s'
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
  ): Promise<{ state: 'matches' | 'mount_missing' | 'diverged' | 'unavailable'; commit?: string; branch?: string }> {
    const mount = await handle.exec({
      // Only a completely empty restore target proves a sleeping Sandbox
      // removed the mount. A missing marker/repository or a partial mount is
      // ambiguous and must never trigger an automatic overwrite.
      command: 'test -d /workspace && test ! -e /workspace/repo && test ! -e /workspace/forge/workspace-id && test -z "$(find /workspace -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)"',
      cwd: '/workspace',
      timeoutMs: 30_000,
      outputLimitBytes: 10_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch(() => undefined);
    if (!mount || mount.truncated) return { state: 'unavailable' };
    if (mount.exitCode === 0) return { state: 'mount_missing' };
    const marker = await handle.exec({
      command: `test "$(cat /workspace/forge/workspace-id 2>/dev/null)" = ${quoted(record.workspace.id)} && test -d /workspace/repo/.git`,
      cwd: '/workspace',
      timeoutMs: 30_000,
      outputLimitBytes: 10_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    }).catch(() => undefined);
    if (!marker || marker.exitCode !== 0 || marker.truncated) return { state: 'unavailable' };
    const identity = await this.gitIdentity(handle).catch(() => undefined);
    if (!identity || !record.workspace.currentCommit) return { state: 'unavailable' };
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
    await this.sandboxProvider.destroy(record.providerId).catch(() => undefined);
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
      restored = await this.sandboxProvider.restore(snapshot, this.restoreInput(record));
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
          kind: this.sandboxProvider.kind,
          version: this.sandboxProvider.version
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
      idempotency: {
        [input.idempotencyKey]: { operationId, revision: 1 }
      }
    };
  }

  async provisionWorkspace(
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
      const handle = await this.sandboxProvider.create(this.restoreInput(record));
      await assertRuntimeProfile(handle, record.workspace.runtimeProfile as CreateWorkspaceInput['runtimeProfile']);

      const source = cloneSource ?? {
        url: `https://github.com/${repositorySlug(record.workspace.repository)}.git`
      };
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
          details: { stage: 'clone', stderr: clone.stderr.slice(0, 2_000) }
        });
      }

      record.workspace.state = 'bootstrapping';
      record.workspace.revision = nextRevision(record.workspace.revision);
      record.workspace.updatedAt = new Date().toISOString();
      await onStateChange(record);
      const detection = await detectProject(handle);
      record.detection = detection;

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
            details: { stage: 'bootstrap', stderr: install.stderr.slice(0, 4_000) }
          });
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
      if (!currentCommit) {
        throw new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'Forge could not resolve the initial Git commit for this workspace.',
          retryable: true,
          details: { stage: 'git_state' }
        });
      }
      record.workspace.currentCommit = currentCommit;
      // `git branch --show-current` is intentionally empty for a tag or a
      // detached commit.  Keep that fact rather than mislabelling the
      // requested ref as a checked-out branch.
      record.workspace.currentBranch = currentBranch || undefined;
      record.workspace.baseCommit = currentCommit;
      record.workspace.initialHeadCommit = currentCommit;
      record.workspace.lastPushedCommit = currentCommit;
      record.workspace.lastPushedBranch = currentBranch || undefined;
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
      await this.sandboxProvider.destroy(record.providerId).catch(() => undefined);
      const forgeError = error instanceof ForgeError
        ? error
        : new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: 'Workspace provisioning failed.',
            retryable: true
          });
      record.workspace.state = forgeError.retryable ? 'provisioning' : 'failed';
      record.workspace.failure = {
        stage: String(forgeError.details?.stage ?? 'provision'),
        code: forgeError.code,
        message: forgeError.message,
        retryable: forgeError.retryable
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
    const handle = await this.sandboxProvider.get(record.providerId);
    const inspection = await this.inspectWorkspace(handle, record);
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
    if (inspection.state === 'mount_missing') return this.recoverActiveCheckpoint(record);
    throw new ForgeError({
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: 'Forge could not safely inspect the workspace filesystem; recovery was not attempted.',
      retryable: true,
      details: { workspaceId: record.workspace.id }
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
    const value = await (await this.handle(record)).applyPatch(input);
    if (!value.applied) {
      throw new ForgeError({
        code: 'FORGE_PATCH_REJECTED',
        message: 'The patch could not be applied cleanly.',
        retryable: false,
        operationId: operation.operationId,
        details: { output: value.output.slice(0, 4_000) }
      });
    }
    const files = await Promise.all(value.changedFiles.map(async (path) => {
      const absolutePath = path.startsWith('/workspace/') ? path : `/workspace/repo/${path}`;
      const observed = await (await this.handle(record)).readFile({ path: absolutePath, maxBytes: 1_000_000 }).catch(() => undefined);
      if (!observed) {
        const absent = await (await this.handle(record)).exec({ command: `test ! -e ${quoted(absolutePath)}`, cwd: '/workspace/repo', timeoutMs: 10_000, outputLimitBytes: 1_000, sessionId: 'system', networkPolicy: 'deny_all' });
        if (absent.exitCode !== 0) throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: 'Forge could not verify a deleted patch path.', retryable: false, operationId: operation.operationId, details: { path: absolutePath } });
        return { path: absolutePath, deleted: true };
      }
      const shellSha256 = await this.shellFileSha256(record, absolutePath);
      if (shellSha256 !== observed.sha256) throw new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: 'Forge shell and file APIs did not observe the same patched bytes.', retryable: false, operationId: operation.operationId, details: { path: absolutePath, fileSha256: observed.sha256, shellSha256 } });
      return { path: absolutePath, resultingSha256: observed.sha256, shellSha256, sizeBytes: observed.sizeBytes };
    }));
    const worktree = await this.gitWorktree(record);
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
    const snapshot = await this.sandboxProvider.snapshot(record.providerId, {
      name: name ?? `forge-${record.workspace.id}-${record.workspace.revision}`,
      ttlSeconds: 7 * 24 * 60 * 60,
      excludeGitignored: false
    });
    const observedAfterSnapshot = await this.workspaceManifest(handle);
    if (
      observedAfterSnapshot.commit !== manifest.commit ||
      observedAfterSnapshot.branch !== manifest.branch ||
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
      await this.sandboxProvider.destroy(record.providerId);
      const restored = await this.sandboxProvider.restore(snapshot, restoreInput);
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
      const recovered = await this.sandboxProvider.restore(rollbackSnapshot, restoreInput)
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
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
          durationMs: 0,
          artifactRefs: [],
          replay: true,
          workspaceId: record.workspace.id,
          branch: record.workspace.currentBranch,
          head: record.workspace.currentCommit,
          classification: decision.classification,
          operationId,
          workspaceRevision: record.workspace.revision
        };
      }
    }
    const handle = await this.handle(record);
    const result = await handle.exec({
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
      workspaceId: record.workspace.id,
      branch: record.workspace.currentBranch,
      head: record.workspace.currentCommit,
      baseCommit: record.workspace.baseCommit,
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
        workspaceId: record.workspace.id,
        branch: record.workspace.currentBranch,
        head: record.workspace.currentCommit,
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
      workspaceId: record.workspace.id,
      branch: record.workspace.currentBranch,
      head: record.workspace.currentCommit,
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

  async processGet(record: WorkspaceRuntimeRecord, processId: ProcessId) {
    const process = await (await this.handle(record)).getProcess(processId);
    if (!process) throw new ForgeError({ code: 'FORGE_PROCESS_NOT_FOUND', message: 'The managed process was not found in this workspace.', retryable: false, details: { processId } });
    return { workspaceId: record.workspace.id, process, recorded: record.processes[processId] ?? null, workspaceRevision: record.workspace.revision };
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
        workspaceId: record.workspace.id,
        processId,
        operationId: operation.operationId,
        workspaceRevision: record.workspace.revision
      };
    }
    await (await this.handle(record)).stopProcess(processId);
    const check = record.checks[processId] ?? null;
    delete record.processes[processId];
    delete record.checks[processId];
    return {
      workspaceId: record.workspace.id,
      processId,
      stopped: true,
      check,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision
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
    record.checks[processId] = { name: input.name.trim(), command: input.command, startedAt: new Date().toISOString(), ...(record.workspace.currentCommit ? { commit: record.workspace.currentCommit } : {}) };
    return { ...started, check: { processId, ...record.checks[processId] } };
  }

  async checkGet(record: WorkspaceRuntimeRecord, processId: ProcessId) {
    const value = await this.processGet(record, processId);
    return { ...value, check: record.checks[processId] ?? null };
  }

  async reconcileGitState(record: WorkspaceRuntimeRecord): Promise<boolean> {
    let handle = await this.sandboxProvider.get(record.providerId);
    const inspection = await this.inspectWorkspace(handle, record);
    if (inspection.state === 'mount_missing') {
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
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: 'Forge could not safely inspect the workspace Git state.',
        retryable: true,
        details: { workspaceId: record.workspace.id }
      });
    }
    return false;
  }

  /**
   * Adopt an identity only immediately after Forge itself performed the Git
   * mutation on this serialized handle. Public reconciliation never calls
   * this method, so an external branch/HEAD change remains a hard error.
   */
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
      branch: record.workspace.currentBranch,
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
        )
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
    // Snapshot captures /workspace with gitignored files included. A
    // normalized tar stream covers every captured path, file mode and
    // symlink target rather than only Git-visible changes. pipefail makes a
    // partial archive (for example, a concurrent write) fail closed.
    const archive = await handle.exec({
      command: "bash -o pipefail -c \"tar --sort=name --format=posix --numeric-owner --mtime='UTC 1970-01-01' --pax-option=delete=atime,delete=ctime -C /workspace -cf - . | sha256sum\"",
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
    return { ...identity, workspaceHash };
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

  async gitDiff(record: WorkspaceRuntimeRecord, staged = false) {
    const diff = await this.exec(record, {
      command: staged
        ? 'git diff --cached --no-ext-diff'
        : 'git diff --no-ext-diff',
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
      outputLimitBytes: 500_000,
      networkPolicy: 'deny_all'
    });
    const names = await (await this.handle(record)).exec({
      command: staged ? 'git diff --cached --name-status -z' : 'git diff --name-status -z',
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 200_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (names.exitCode !== 0) throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Forge could not enumerate changed paths.', retryable: false });
    const values = names.stdout.split('\0').filter(Boolean);
    const files: Array<{ status: string; path: string; previousPath?: string }> = [];
    for (let index = 0; index < values.length;) {
      const status = values[index++];
      const path = values[index++];
      if (!status || !path) break;
      if (status.startsWith('R') || status.startsWith('C')) {
        const nextPath = values[index++];
        if (nextPath) files.push({ status, previousPath: path, path: nextPath });
      } else files.push({ status, path });
    }
    return { ...diff, files, workspaceId: record.workspace.id, branch: record.workspace.currentBranch, head: record.workspace.currentCommit, filesystemRevision: record.workspace.revision };
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
    if (!branch || !commit) throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'Forge cannot prove a remote branch without a recorded pushed branch and commit.', retryable: false });
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
        cwd: '/workspace/repo', timeoutMs: 60_000, outputLimitBytes: 10_000,
        sessionId: 'system', networkPolicy: 'development',
        environment: cloneSource?.authorizationHeader
          ? { GIT_CONFIG_GLOBAL: configPath, GIT_TERMINAL_PROMPT: '0' }
          : { GIT_TERMINAL_PROMPT: '0' }
      });
    } finally {
      if (cloneSource?.authorizationHeader) {
        await handle.exec({
          command: `rm -f ${quoted(configPath)}`,
          cwd: '/workspace', timeoutMs: 10_000, outputLimitBytes: 1_000,
          sessionId: 'system', networkPolicy: 'deny_all'
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
      throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'Forge will not destroy a workspace until the remote branch is proven to resolve to the recorded pushed commit.', retryable: false, details: { branch, expectedCommit: commit, observedRemoteCommit: remoteCommit || null, truncated: remote.truncated, stderr: remote.stderr.slice(0, 2_000) } });
    }
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
    const stage = await handle.exec({
      command: `git add -- ${paths.map(quoted).join(' ')}`,
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 50_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (stage.exitCode !== 0) throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Forge could not stage the selected files.', retryable: false });
    const commit = await handle.exec({
      command: `git commit -m ${quoted(input.message.trim())}`,
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
    await this.adoptOwnedGitTransition(record, handle, { branch: record.workspace.currentBranch });
    return { commit: record.workspace.currentCommit, branch: record.workspace.currentBranch, operationId: operation.operationId, workspaceRevision: record.workspace.revision };
  }

  async gitOutgoingDiff(record: WorkspaceRuntimeRecord, base: string) {
    assertRef(base);
    if (base !== record.workspace.requestedRef) {
      throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'Forge only compares and submits against the immutable base ref recorded when this workspace was created.', retryable: false, details: { requestedBase: record.workspace.requestedRef, providedBase: base, baseCommit: record.workspace.baseCommit ?? null } });
    }
    const immutableBase = record.workspace.baseCommit ?? base;
    const result = await (await this.handle(record)).exec({
      command: `git diff --no-ext-diff --binary ${quoted(immutableBase)}...HEAD`,
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 1_000_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0 || result.truncated) throw new ForgeError({ code: 'FORGE_OUTPUT_TRUNCATED', message: 'Forge could not calculate a complete outgoing change for approval.', retryable: false, details: { truncated: result.truncated } });
    return { diff: result.stdout, diffHash: await sha256Text(result.stdout), branch: record.workspace.currentBranch, baseRef: base, baseCommit: immutableBase };
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
    const handle = await this.sandboxProvider.get(record.providerId);
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
    await this.sandboxProvider.destroy(record.providerId);
    record.workspace.state = 'destroyed';
    record.workspace.revision = nextRevision(record.workspace.revision);
    record.workspace.updatedAt = new Date().toISOString();
    record.processes = {};
    record.checks = {};
    record.previews = {};
    return { workspaceRevision: record.workspace.revision, replay: false };
  }

}
