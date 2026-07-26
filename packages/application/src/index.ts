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
  ExecInput,
  FileReadInput,
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
      previews: {},
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
      const handle = await this.sandboxProvider.create({
        providerId: record.providerId,
        runtimeProfile: record.workspace.runtimeProfile as CreateWorkspaceInput['runtimeProfile'],
        labels: {
          workspaceId: record.workspace.id,
          tenantId: record.workspace.tenantId,
          repository: repositorySlug(record.workspace.repository)
        },
        idleTimeout: '90s'
      });

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
      record.workspace.currentCommit = currentCommit;
      record.workspace.currentBranch = currentBranch || record.workspace.requestedRef;
      record.workspace.lastPushedCommit = currentCommit;
      record.workspace.lastPushedBranch = record.workspace.currentBranch;
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
    return this.sandboxProvider.get(record.providerId);
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
      throw new ForgeError({
        code: 'FORGE_PATCH_REJECTED',
        message: 'The patch could not be applied cleanly.',
        retryable: false,
        operationId: operation.operationId,
        details: { output: value.output.slice(0, 4_000) }
      });
    }
    return {
      value,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision
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

  async reconcileGitState(record: WorkspaceRuntimeRecord): Promise<boolean> {
    const result = await (await this.handle(record)).exec({
      command: 'git rev-parse HEAD && git branch --show-current',
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 10_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0) throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Forge could not reconcile the workspace Git state.', retryable: false });
    const [currentCommit = '', currentBranch = ''] = result.stdout.trim().split('\n');
    if (!currentCommit) throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Workspace Git state has no checked-out commit.', retryable: false });
    const changed = record.workspace.currentCommit !== currentCommit || record.workspace.currentBranch !== currentBranch;
    const isInitialCheckedOutRef = !record.workspace.lastPushedCommit && currentBranch === record.workspace.requestedRef;
    if (changed || isInitialCheckedOutRef) {
      record.workspace.currentCommit = currentCommit;
      record.workspace.currentBranch = currentBranch;
      if (isInitialCheckedOutRef) {
        record.workspace.lastPushedCommit = currentCommit;
        record.workspace.lastPushedBranch = currentBranch;
      }
      record.workspace.updatedAt = new Date().toISOString();
    }
    return changed || isInitialCheckedOutRef;
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
      branch: record.workspace.currentBranch,
      commit: record.workspace.currentCommit,
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

  async assertDestroySafe(record: WorkspaceRuntimeRecord): Promise<void> {
    const status = await this.gitStatus(record);
    if (!status.clean || status.sync.state !== 'pushed') {
      throw new ForgeError({
        code: 'FORGE_GIT_PUSH_BLOCKED',
        message: 'Forge will not destroy a workspace with uncommitted or unpushed work. Reconcile, commit, and push the current Forge branch first.',
        retryable: false,
        details: { clean: status.clean, sync: status.sync }
      });
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
    const result = await (await this.handle(record)).exec({
      command: `git switch -c ${quoted(branch)}`,
      cwd: '/workspace/repo', timeoutMs: 30_000, outputLimitBytes: 50_000,
      sessionId: 'system', networkPolicy: 'deny_all'
    });
    if (result.exitCode !== 0) throw new ForgeError({ code: 'FORGE_GIT_DIRTY', message: 'Forge could not create the branch.', retryable: false });
    await this.reconcileGitState(record);
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
    await this.reconcileGitState(record);
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
    const handle = await this.sandboxProvider.get(record.providerId);
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
    record.previews = {};
    return { workspaceRevision: record.workspace.revision, replay: false };
  }

}
