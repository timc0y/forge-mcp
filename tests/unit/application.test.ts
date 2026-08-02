import { describe, expect, it } from 'vitest';
import {
  ForgeApplicationService,
  LAZY_REQUESTED_NEXT_ACTIONS,
  workspaceAllowedNextActions,
  type WorkspaceRuntimeRecord
} from '@forge/application';
import { ForgeError, ids } from '@forge/core';
import type {
  CreateSandboxInput,
  ProcessRecord,
  SandboxHandle,
  SandboxProvider
} from '@forge/sandbox-core';

class FakeProvider implements SandboxProvider {
  readonly kind = 'cloudflare' as const;
  readonly version = 'test';
  readonly calls: string[] = [];
  readonly files = new Map<string, string>();
  readonly startedSessions: string[] = [];
  readonly processStates = new Map<string, ProcessRecord>();
  lastProcessWaitTimeoutMs?: number;
  head = 'abcdef';
  branch = 'main';
  workspacePresent = true;
  workspaceMarkerPresent = true;
  workspaceOtherContentPresent = false;
  workspaceProbeFails = false;
  worktreeDiff = '';
  workspaceHash = 'a'.repeat(64);
  nodeModulesVisible = true;
  private commitSequence = 0;
  readonly handle: SandboxHandle = {
    providerId: 'fake',
    exec: async (input) => {
      this.calls.push(input.command);
      if (input.command.includes('FORGE_NODE_MODULES=') || input.command.includes('FORGE_DEPS_VISIBLE')) {
        return {
          exitCode: 0,
          stdout: this.nodeModulesVisible
            ? 'FORGE_NODE_MODULES=present\nFORGE_PYTHON_ENV=absent\nFORGE_LOCKFILE=present\nFORGE_DEPS_VISIBLE\n'
            : 'FORGE_NODE_MODULES=absent\nFORGE_PYTHON_ENV=absent\nFORGE_DEPS_MISSING\n',
          stderr: '',
          truncated: false,
          durationMs: 1,
          artifactRefs: []
        };
      }
      if (input.command.startsWith('sha256sum pnpm-lock.yaml')) {
        return { exitCode: 0, stdout: `${'b'.repeat(64)}\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command === 'node --version && corepack --version') {
        return { exitCode: 0, stdout: 'v24.12.0\n0.34.1\n', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.startsWith('git clone')) {
        return { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.includes('===FORGE_HEAD===')) {
        return {
          exitCode: 0,
          stdout: [
            '===FORGE_HEAD===',
            this.head,
            '===FORGE_BRANCH===',
            this.branch,
            '===FORGE_DETECTION===',
            JSON.stringify({ pm: 'npm', framework: 'vite', scripts: { dev: 'vite', build: 'vite build' } })
          ].join('\n'),
          stderr: '', truncated: false, durationMs: 1, artifactRefs: []
        };
      }
      if (input.command === 'npm ci') {
        return { exitCode: this.install.strict ?? 0, stdout: '', stderr: 'frozen lockfile mismatch', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.startsWith('git rev-parse')) {
        return { exitCode: 0, stdout: `${this.head}\n${this.branch}\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.includes('test -d /workspace && test ! -e /workspace/forge/workspace-id && test ! -d /workspace/repo/.git')) {
        if (this.workspaceProbeFails) throw new Error('sandbox probe timed out');
        return !this.workspacePresent && !this.workspaceOtherContentPresent
          ? { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] }
          : { exitCode: 1, stdout: '', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.includes('/workspace/forge/workspace-id')) {
        return this.workspacePresent && this.workspaceMarkerPresent
          ? { exitCode: 0, stdout: `${this.head}\n${this.branch}\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] }
          : { exitCode: 1, stdout: '', stderr: 'workspace mount is unavailable', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.includes('find /workspace -xdev -mindepth 1')) {
        return { exitCode: 0, stdout: `${this.workspaceHash}  -\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.startsWith('git switch -c ')) {
        this.branch = input.command.match(/'([^']+)'/u)?.[1] ?? '';
        return { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.includes('git commit -m ')) {
        this.commitSequence += 1;
        this.head = this.commitSequence.toString(16).repeat(40);
        return { exitCode: 0, stdout: `${this.head}\n${this.branch}\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.startsWith('git status --porcelain=v2 --branch &&')) {
        return { exitCode: 0, stdout: `# branch.head ${this.branch}\n${this.head}\n${this.branch}\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command === 'git diff --no-ext-diff --binary && git diff --cached --no-ext-diff --binary') {
        return { exitCode: 0, stdout: this.worktreeDiff, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command === 'npm install') {
        return { exitCode: this.install.lenient ?? 0, stdout: '', stderr: 'install failed', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command === 'git status --porcelain=v2 --branch') {
        return { exitCode: 0, stdout: `# branch.head ${this.branch}\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.startsWith('git ls-remote --exit-code origin ')) {
        return { exitCode: 0, stdout: `${this.head}\trefs/heads/${this.branch}\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.startsWith('sha256sum -- ')) {
        const path = input.command.match(/'([^']+)'$/u)?.[1] ?? '';
        const content = this.files.get(path) ?? '';
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        return { exitCode: 0, stdout: `${sha256} ${path}\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      return { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
    },
    startProcess: async (input) => {
      this.startedSessions.push(input.sessionId);
      this.processStates.set(input.processId, {
        id: input.processId,
        providerProcessId: input.processId,
        command: input.command,
        cwd: input.cwd,
        status: 'running',
        pid: 123,
        startedAt: new Date().toISOString(),
        mutatesFilesystem: input.mutatesFilesystem ?? true
      });
      return this.processStates.get(input.processId)!;
    },
    getProcess: async (processId) => this.processStates.get(processId) ?? null,
    processWait: async ({ processId, timeoutMs = 120_000 }) => {
      this.lastProcessWaitTimeoutMs = timeoutMs;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const current = this.processStates.get(processId);
        if (!current) {
          return {
            id: processId,
            providerProcessId: processId,
            command: '',
            cwd: '/workspace/repo',
            status: 'failed' as const,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: 1,
            mutatesFilesystem: false
          };
        }
        if (current.status !== 'running' && current.status !== 'starting') return current;
        if (Date.now() >= deadline) {
          throw new ForgeError({
            code: 'FORGE_COMMAND_TIMEOUT',
            message: `Timed out waiting for process ${processId}`,
            retryable: true,
            details: { processId, status: 'running', timeoutMs }
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    readProcessLogs: async (input) => {
      const full = 'line1\nline2\nDone in 3m\n';
      const start = Number.parseInt(input.cursor ?? '0', 10) || 0;
      const data = full.slice(start, start + input.limitBytes);
      const next = start + data.length;
      return {
        data,
        nextCursor: next < full.length ? String(next) : undefined,
        truncated: next < full.length
      };
    },
    stopProcess: async (processId) => {
      const current = this.processStates.get(processId);
      if (current) this.processStates.set(processId, { ...current, status: 'stopped', completedAt: new Date().toISOString(), exitCode: 0 });
    },
    readFile: async ({ path, maxBytes }) => {
      if (path === '/workspace/forge/workspace-id') {
        if (this.workspaceProbeFails) {
          throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: 'sandbox probe timed out', retryable: true });
        }
        if (!this.workspacePresent || !this.workspaceMarkerPresent) {
          throw new ForgeError({ code: 'FORGE_FILE_NOT_FOUND', message: 'Sandbox file was not found.', retryable: false });
        }
        const content = 'forge-workspace-marker';
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
        return { path, content, sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''), sizeBytes: content.length, truncated: false };
      }
      const content = this.files.get(path);
      if (content === undefined) throw new Error('FILE_NOT_FOUND');
      const bytes = new TextEncoder().encode(content);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return { path, content: new TextDecoder().decode(bytes.slice(0, maxBytes)), sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''), sizeBytes: bytes.byteLength, truncated: bytes.byteLength > maxBytes };
    },
    writeFile: async ({ path, content }) => {
      this.files.set(path, content);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
      return { path, sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''), sizeBytes: new TextEncoder().encode(content).byteLength };
    },
    listFiles: async () => {
      if (this.workspaceProbeFails) throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: 'sandbox probe timed out', retryable: true });
      if (!this.workspacePresent && this.workspaceOtherContentPresent) return {
        entries: [{ path: '/workspace/repo/untracked.txt', type: 'file' as const }],
        truncated: false
      };
      if (!this.workspacePresent) return {
        entries: [
          { path: '/workspace/repo', type: 'directory' as const },
          { path: '/workspace/forge', type: 'directory' as const },
          { path: '/workspace/cache', type: 'directory' as const }
        ],
        truncated: false
      };
      if (!this.workspaceMarkerPresent) return {
        entries: [
          { path: '/workspace/repo', type: 'directory' as const },
          { path: '/workspace/repo/.git', type: 'directory' as const }
        ],
        truncated: false
      };
      if (this.workspaceOtherContentPresent) return {
        entries: [{ path: '/workspace/repo/untracked.txt', type: 'file' as const }],
        truncated: false
      };
      return { entries: [], truncated: false };
    },
    exposePort: async () => ({ port: 5173, providerUrl: 'https://provider.invalid', name: 'preview' }),
    revokePort: async () => undefined
  };

  constructor(
    private readonly createError?: Error,
    private readonly install: { strict?: number; lenient?: number } = {}
  ) {}

  keepAlive = false;
  async create(_input: CreateSandboxInput) {
    if (this.createError) throw this.createError;
    return this.handle;
  }
  async get() { return this.handle; }
  async setKeepAlive(_providerId: string, keepAlive: boolean) {
    this.keepAlive = keepAlive;
    this.calls.push(`keepAlive:${keepAlive}`);
  }
  async destroy() { this.calls.push('destroy'); }
}

function initialized(service: ForgeApplicationService): WorkspaceRuntimeRecord {
  return service.initializeWorkspace({
    workspaceId: ids.workspace(),
    tenantId: ids.tenant(),
    projectId: ids.project(),
    repository: { provider: 'github', owner: 'example', name: 'project' },
    ref: 'main',
    runtimeProfile: 'node-24',
    persistence: 'ephemeral',
    bootstrap: true,
    idempotencyKey: 'create-request-123',
    actor: { type: 'agent', id: 'tester' }
  });
}

function ready(record: WorkspaceRuntimeRecord): void {
  record.workspace.state = 'ready';
  record.workspace.currentCommit = 'abcdef';
  record.workspace.currentBranch = 'main';
}

describe('workspaceAllowedNextActions', () => {
  it('steers lazy requested workspaces to GitHub tools instead of only polling get', () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    record.workspace.currentBranch = 'forge/lazy-guidance';
    expect(record.workspace.state).toBe('requested');
    expect(workspaceAllowedNextActions(record)).toEqual([...LAZY_REQUESTED_NEXT_ACTIONS]);
  });

  it('keeps provisioning workspaces on forge_workspace_get only', () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    record.workspace.state = 'provisioning';
    record.workspace.currentBranch = 'forge/lazy-guidance';
    expect(workspaceAllowedNextActions(record)).toEqual(['forge_workspace_get']);
  });

  it('keeps bootstrapping workspaces on forge_workspace_get only', () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    record.workspace.state = 'bootstrapping';
    record.workspace.currentBranch = 'forge/lazy-guidance';
    expect(workspaceAllowedNextActions(record)).toEqual(['forge_workspace_get']);
  });
});

describe('describeWorkspaceLifecycle', () => {
  it('exports the shared lazy-create view used by observer receipts', async () => {
    const { describeWorkspaceLifecycle } = await import('../../packages/application/src/index');
    const view = describeWorkspaceLifecycle('requested', { branch: 'forge/x', head: 'deadbeef' });
    expect(view.lifecycle).toBe('lazy_control_plane');
    expect(view.executor_state).toBe('not_loaded');
    expect(view.allowedNextActions).toEqual([...LAZY_REQUESTED_NEXT_ACTIONS]);
  });
});

describe('Forge application service', () => {
  it('records a caller-supplied workspace operation receipt for timed-out initialize recovery', () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const operationId = ids.operation();
    const record = service.initializeWorkspace({
      workspaceId: ids.workspace(),
      operationId,
      tenantId: ids.tenant(),
      projectId: ids.project(),
      repository: { provider: 'github', owner: 'example', name: 'project' },
      ref: 'main',
      runtimeProfile: 'node-24',
      persistence: 'ephemeral',
      bootstrap: true,
      idempotencyKey: 'create-with-receipt-1',
      actor: { type: 'agent', id: 'tester' }
    });

    expect(record.idempotency['create-with-receipt-1']?.operationId).toBe(operationId);
  });

  it('advances a loaded executor to the GitHub commit without deleting untracked caches', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    record.dependencyState = {
      lockfileHash: 'old-lockfile',
      installedAt: new Date().toISOString(),
      usable: true
    };
    record.detection = { packageManager: 'npm', framework: 'vite', installCommand: 'npm ci' } as never;
    const commit = '1'.repeat(40);

    await service.syncRemoteCommit(record, commit, 'main', true, {
      url: 'https://github.invalid/example/project.git',
      authorizationHeader: 'Bearer test'
    });

    const syncCommand = provider.calls.find((command) => command.includes('git fetch --no-tags'));
    expect(syncCommand).toContain(`git reset --hard '${commit}'`);
    expect(syncCommand).not.toContain('git clean');
    expect(record.workspace.currentCommit).toBe(commit);
    expect(record.executorCommit).toBe(commit);
    expect(record.workspace.checkout?.healthy).toBe(true);
    expect(record.dependencyState).toBeUndefined();
    expect(record.detection).toBeUndefined();
  });

  it('keeps installed dependency state when a GitHub edit does not change dependency inputs', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const dependencyState = {
      lockfileHash: 'same-lockfile',
      installedAt: new Date().toISOString(),
      usable: true
    };
    record.dependencyState = dependencyState;

    await service.syncRemoteCommit(record, '2'.repeat(40), 'main', false, {
      url: 'https://github.invalid/example/project.git'
    });

    expect(record.dependencyState).toBe(dependencyState);
  });

  it('rejects client operations until provisioning has completed', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);

    record.workspace.state = 'provisioning';
    await expect(service.gitStatus(record))
      .rejects.toMatchObject({ code: 'FORGE_WORKSPACE_NOT_READY' });

    record.workspace.state = 'bootstrapping';
    await expect(service.gitStatus(record))
      .rejects.toMatchObject({ code: 'FORGE_WORKSPACE_NOT_READY' });
  });

  it('fails closed when the workspace marker is missing but the repository mount remains', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    provider.workspaceMarkerPresent = false;

    await expect(service.gitStatus(record))
      .rejects.toMatchObject({ code: 'FORGE_PROVIDER_UNAVAILABLE' });
  });

  it('never overwrites other content when the workspace mount is incomplete', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    provider.workspacePresent = false;
    provider.workspaceOtherContentPresent = true;

    await expect(service.gitStatus(record))
      .rejects.toMatchObject({ code: 'FORGE_PROVIDER_UNAVAILABLE' });
  });

  it('fails closed when the workspace probe itself is unavailable', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    provider.workspaceProbeFails = true;

    await expect(service.gitStatus(record))
      .rejects.toMatchObject({ code: 'FORGE_PROVIDER_UNAVAILABLE' });
  });

  it('fails closed on a live Git divergence', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    provider.head = 'different-commit';

    await expect(service.gitStatus(record))
      .rejects.toMatchObject({ code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED' });
  });

  it('keeps a detached checkout distinct from a checked-out branch', async () => {
    const provider = new FakeProvider();
    provider.branch = '';
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    record.workspace.requestedRef = 'v1.0.0';

    await service.provisionWorkspace(record, false);
    // The tag is never mislabelled as a checked-out branch and provisioning
    // never invents a container-only branch for it.
    expect(record.workspace.currentBranch).toBeUndefined();
    expect(record.workspace.requestedRef).toBe('v1.0.0');
    await expect(service.gitStatus(record)).resolves.toMatchObject({ branch: 'v1.0.0' });
  });

  it('rejects an external branch checkout even when detached HEAD stays on the same commit', async () => {
    const provider = new FakeProvider();
    provider.branch = '';
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    record.workspace.requestedRef = 'v1.0.0';
    await service.provisionWorkspace(record, false);
    provider.branch = 'main';

    await expect(service.gitStatus(record))
      .rejects.toMatchObject({ code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED' });
  });

  it('falls back to a lenient install when the frozen install rejects the lockfile', async () => {
    const provider = new FakeProvider(undefined, { strict: 1, lenient: 0 });
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, true);
    expect(record.workspace.state).toBe('ready');
    expect(record.workspace.bootstrapWarning).toBeUndefined();
    // Strict install ran and failed, so the lenient fallback was attempted.
    expect(provider.calls).toContain('npm ci');
    expect(provider.calls).toContain('npm install');
  });

  it('comes up ready with a non-fatal warning when dependency install cannot complete', async () => {
    const provider = new FakeProvider(undefined, { strict: 1, lenient: 1 });
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    // A failing install must NOT sink the workspace.
    await service.provisionWorkspace(record, true);
    expect(record.workspace.state).toBe('ready');
    expect(record.workspace.bootstrapWarning).toMatchObject({ phase: 'dependency_install' });
    expect(provider.calls).not.toContain('destroy');
  });

  it('keeps retryable provisioning failures non-terminal until retries are exhausted', async () => {
    const service = new ForgeApplicationService(new FakeProvider(new Error('temporary outage')));
    const record = initialized(service);

    await expect(service.provisionWorkspace(record, true)).rejects.toMatchObject({
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      retryable: true
    });
    expect(record.workspace).toMatchObject({
      state: 'provisioning',
      failure: { retryable: true }
    });

    service.markProvisioningExhausted(record);
    expect(record.workspace).toMatchObject({
      state: 'failed',
      failure: { retryable: false }
    });
  });

  it('makes non-retryable provisioning failures terminal immediately', async () => {
    const service = new ForgeApplicationService(new FakeProvider(new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'invalid repository',
      retryable: false
    })));
    const record = initialized(service);

    await expect(service.provisionWorkspace(record, true)).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED',
      retryable: false
    });
    expect(record.workspace).toMatchObject({
      state: 'failed',
      failure: { retryable: false }
    });
  });

  it('only stops a process that belongs to the explicit workspace', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    ready(record);
    const started = await service.startProcess(record, { command: 'pnpm dev', cwd: '/workspace/repo', networkPolicy: 'development', idempotencyKey: 'process-123456', expectedRevision: 1 });
    if ('replay' in started) throw new Error('Unexpected process replay.');
    await expect(service.stopProcess(record, started.value.id, undefined, 'stop-123456')).resolves.toMatchObject({ stopped: true, processId: started.value.id });
    await expect(service.stopProcess(record, started.value.id, undefined, 'stop-123457')).rejects.toMatchObject({ code: 'FORGE_PROCESS_NOT_FOUND' });
  });

  it('starts approved dependency installs on the shared agent-default session', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const started = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-123456',
      expectedRevision: 1,
      approved: true
    });
    if ('replay' in started) throw new Error('Unexpected process replay.');
    expect(provider.startedSessions).toContain('agent-default');
    expect(record.processes[started.value.id]).toMatchObject({
      command: 'pnpm install',
      mutatesFilesystem: true
    });
  });

  it('rejects unapproved dependency installs as managed processes', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    ready(record);
    await expect(service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-123457',
      expectedRevision: 1
    })).rejects.toMatchObject({ code: 'FORGE_APPROVAL_REQUIRED' });
  });

  it('finalizes a successful managed install so later shells can see dependencies', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const started = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-final-1',
      expectedRevision: 1,
      approved: true
    });
    if ('replay' in started) throw new Error('Unexpected process replay.');
    const processId = started.value.id;
    provider.processStates.set(processId, {
      ...provider.processStates.get(processId)!,
      status: 'exited',
      completedAt: new Date().toISOString(),
      exitCode: 0
    });
    const waited = await service.processWait(record, processId, 1_000);
    expect(waited.process).toMatchObject({ status: 'exited', exitCode: 0, mutatesFilesystem: true });
    expect(waited.dependencyState).toMatchObject({ status: 'ready', usable: true, lockfileHash: 'b'.repeat(64) });
    expect(waited).not.toHaveProperty('filesystemCheckpointed');
    expect(record.dependencyState).toMatchObject({ usable: true, lockfileHash: 'b'.repeat(64) });
    expect(record.processes[processId]?.completedAt).toBeTruthy();
    expect(record.processes[processId]?.finalizedAt).toBeTruthy();
    expect(provider.calls.some((command) => command.includes('FORGE_NODE_MODULES='))).toBe(true);
  });

  it('fails closed when a managed install exits but node_modules is not shell-visible', async () => {
    const provider = new FakeProvider();
    provider.nodeModulesVisible = false;
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const started = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-final-2',
      expectedRevision: 1,
      approved: true
    });
    if ('replay' in started) throw new Error('Unexpected process replay.');
    const processId = started.value.id;
    provider.processStates.set(processId, {
      ...provider.processStates.get(processId)!,
      status: 'exited',
      completedAt: new Date().toISOString(),
      exitCode: 0
    });
    await expect(service.processWait(record, processId, 1_000)).rejects.toMatchObject({
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: expect.stringContaining('not visible to the workspace shell')
    });
    expect(record.dependencyState).toMatchObject({ usable: false });
  });

  it('keeps the ephemeral executor alive after mutations so later commands see its files', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const started = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-keepalive-1',
      expectedRevision: 1,
      approved: true
    });
    if ('replay' in started) throw new Error('Unexpected replay.');
    expect(provider.keepAlive).toBe(true);
    const processId = started.value.id;
    provider.processStates.set(processId, {
      ...provider.processStates.get(processId)!,
      status: 'exited',
      completedAt: new Date().toISOString(),
      exitCode: 0
    });
    await service.processWait(record, processId, 1_000);
    expect(provider.keepAlive).toBe(true);
    expect(provider.calls).toContain('keepAlive:true');
    expect(provider.calls).not.toContain('keepAlive:false');
  });

  it('refuses executor replacement while a mutating process is active', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    record.processes.proc_live_install = {
      command: 'pnpm install',
      startedAt: new Date().toISOString(),
      mutatesFilesystem: true
    };
    provider.processStates.set('proc_live_install', {
      id: 'proc_live_install',
      providerProcessId: 'proc_live_install',
      command: 'pnpm install',
      cwd: '/workspace/repo',
      status: 'running',
      pid: 42,
      startedAt: new Date().toISOString(),
      mutatesFilesystem: true
    });
    provider.workspacePresent = false;
    await expect(service.gitStatus(record))
      .rejects.toMatchObject({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: expect.stringContaining('will not replace the executor')
      });
  });

  it('syncs finished processes so they stop blocking later work', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const processId = 'proc_probe';
    record.processes[processId] = {
      command: 'touch .forge-persistence-probe',
      startedAt: new Date().toISOString(),
      mutatesFilesystem: true
    };
    provider.processStates.set(processId, {
      id: processId,
      providerProcessId: processId,
      command: 'touch .forge-persistence-probe',
      cwd: '/workspace/repo',
      status: 'exited',
      pid: 7,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      mutatesFilesystem: true
    });
    const synced = await service.syncProcessLifecycle(record);
    expect(synced.completed).toBe(1);
    expect(synced.running).toBe(0);
    expect(record.processes[processId]?.completedAt).toBeTruthy();
    expect(record.processes[processId]?.finalizedAt).toBeTruthy();
  });

  it('replays managed process starts with the original process id', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const first = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-replay-1',
      expectedRevision: 1,
      approved: true
    });
    if ('replay' in first) throw new Error('Unexpected first replay.');
    const second = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-replay-1',
      expectedRevision: 1,
      approved: true
    });
    if (!('replay' in second) || !second.replay) throw new Error('Expected idempotent replay.');
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.status).toBe('running');
  });

  it('does not mark a process complete on a transient provider lookup failure', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    const processId = 'proc_still_live';
    record.processes[processId] = {
      command: 'pnpm install',
      startedAt: new Date().toISOString(),
      mutatesFilesystem: true
    };
    let lookups = 0;
    provider.handle.getProcess = async () => {
      lookups += 1;
      throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: 'blip', retryable: true });
    };
    provider.workspaceProbeFails = true;
    await expect(service.gitStatus(record))
      .rejects.toMatchObject({ code: 'FORGE_PROVIDER_UNAVAILABLE' });
    expect(lookups).toBeGreaterThan(0);
    expect(record.processes[processId]?.completedAt).toBeUndefined();
  });

  it('adopts tracked processes and retries before failing closed on unavailable inspection', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    const processId = 'proc_adopt_me';
    record.processes[processId] = {
      command: 'pnpm install',
      startedAt: new Date().toISOString(),
      mutatesFilesystem: true
    };
    provider.processStates.set(processId, {
      id: processId,
      providerProcessId: processId,
      command: 'pnpm install',
      cwd: '/workspace/repo',
      status: 'exited',
      pid: 9,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 0,
      mutatesFilesystem: true
    });
    provider.workspaceProbeFails = true;
    await expect(service.gitStatus(record))
      .rejects.toMatchObject({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        details: expect.objectContaining({ recoveryAttempted: true })
      });
    expect(record.processes[processId]?.completedAt).toBeTruthy();
  });

  it('separates destroy request from durable completion', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    provider.branch = 'forge/base';
    record.workspace.currentCommit = 'abcdef';
    record.workspace.currentBranch = 'forge/base';
    const request = service.requestDestroy(record, 1, 'destroy-123456');
    expect(request.state).toBe('destroying');
    await service.completeDestroy(record);
    expect(record.workspace.state).toBe('destroyed');
    expect(provider.calls).toContain('destroy');
  });

  it('discards executor changes during workspace teardown', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    provider.branch = 'forge/base';
    record.workspace.currentCommit = 'abcdef';
    record.workspace.currentBranch = 'forge/base';
    service.requestDestroy(record, 1, 'destroy-123456');
    provider.head = '1234567';
    await expect(service.completeDestroy(record)).resolves.toMatchObject({ replay: false });
    expect(record.workspace.state).toBe('destroyed');
  });

  it('force-completes teardown without inspecting a missing mount or requiring provider cleanup to succeed', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    service.requestDestroy(record, 1, 'destroy-force-missing-mount', true);
    provider.handle.exec = async () => {
      throw new Error('workspace mount is unavailable');
    };
    provider.destroy = async () => {
      throw new Error('sandbox already absent');
    };

    await expect(service.completeDestroy(record)).resolves.toMatchObject({ replay: false });
    expect(record.workspace.state).toBe('destroyed');
    expect(record.processes).toEqual({});
    expect(record.previews).toEqual({});
  });

  it('preserves the concrete setup failure when provisioning retries are exhausted', () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    service.recordProvisioningFailure(record, new ForgeError({
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: 'GitHub installation 42 could not mint a clone capability.',
      retryable: true,
      details: { stage: 'clone_source', cause: 'installation revoked' }
    }));

    service.markProvisioningExhausted(record);

    expect(record.workspace.state).toBe('failed');
    expect(record.workspace.failure).toMatchObject({
      stage: 'clone_source',
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: 'GitHub installation 42 could not mint a clone capability.',
      retryable: false,
      details: { cause: 'installation revoked' }
    });
  });

  it('returns incremental process logs with status and null nextCursor when done', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const started = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-logs-1',
      expectedRevision: 1,
      approved: true
    });
    if ('replay' in started) throw new Error('Unexpected replay.');
    const first = await service.processLogs(record, started.value.id);
    expect(first.data.length).toBeGreaterThan(0);
    expect(first.hasMore).toBe(false);
    expect(first.nextCursor).toBeNull();
    expect(first.status).toBe('running');
    expect(first.mutatesFilesystem).toBe(true);
  });

  it('lists processes and reconciles operations by id', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const started = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-op-1',
      expectedRevision: 1,
      approved: true
    });
    if ('replay' in started) throw new Error('Unexpected replay.');
    const listed = await service.processList(record);
    expect(listed.processes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: started.value.id, status: 'running', mutatesFilesystem: true })
    ]));
    expect(listed.dependencyState).toMatchObject({ status: 'unknown', reason: 'not_observed' });
    const operation = await service.operationGet(record, started.operationId);
    expect(operation).toMatchObject({
      operationId: started.operationId,
      status: 'active',
      processId: started.value.id,
      idempotencyKey: 'install-op-1'
    });
    const replayed = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-op-1',
      expectedRevision: 1,
      approved: true
    });
    expect(replayed).toMatchObject({
      replayed: true,
      idempotencyKey: 'install-op-1',
      originalOperationId: started.operationId,
      value: { id: started.value.id }
    });
  });

  it('injects non-interactive environment for managed processes', async () => {
    const provider = new FakeProvider();
    const seenEnv: Record<string, string>[] = [];
    const original = provider.handle.startProcess;
    provider.handle.startProcess = async (input) => {
      seenEnv.push(input.environment ?? {});
      return original.call(provider.handle, input);
    };
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-env-1',
      expectedRevision: 1,
      approved: true,
      environment: { CUSTOM: '1' }
    });
    expect(seenEnv[0]).toMatchObject({
      CI: '1',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      GIT_TERMINAL_PROMPT: '0',
      CUSTOM: '1'
    });
  });

  it('runs forge_deps_install via managed process wait + visibility finalize', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    record.detection = {
      packageManager: 'pnpm',
      installCommand: 'pnpm install',
      installFallbackCommand: 'pnpm install',
      framework: 'vite',
      scripts: { dev: 'vite' }
    } as never;
    // Complete the install as soon as it is started.
    const originalStart = provider.handle.startProcess!;
    provider.handle.startProcess = async (input) => {
      const started = await originalStart.call(provider.handle, input);
      provider.processStates.set(input.processId, {
        ...started,
        status: 'exited',
        completedAt: new Date().toISOString(),
        exitCode: 0
      });
      return started;
    };
    const result = await service.dependenciesInstall(record, {
      networkPolicy: 'package_install',
      idempotencyKey: 'deps-managed-1',
      expectedRevision: 1,
      timeoutMs: 5_000,
      hostSafeWaitMs: 5_000
    });
    expect(result).toMatchObject({
      success: true,
      managedProcess: true,
      remotePersisted: false,
      executorFilesystem: 'ephemeral',
      dependencyState: { status: 'ready', usable: true }
    });
    expect(result.processId).toMatch(/^proc_/);
  });

  it('returns timedOut process waits with suggestedTimeoutMs instead of killing or throwing', async () => {
    const provider = new FakeProvider();
    provider.handle.processWait = async ({ processId, timeoutMs }) => {
      provider.lastProcessWaitTimeoutMs = timeoutMs;
      return provider.processStates.get(processId)!;
    };
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const started = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'install-wait-timeout-1',
      expectedRevision: 1,
      approved: true
    });
    if ('replay' in started) throw new Error('Unexpected replay.');
    const waited = await service.processWait(record, started.value.id, 600_000);
    expect(waited.timedOut).toBe(true);
    expect(provider.lastProcessWaitTimeoutMs).toBe(30_000);
    expect(waited.suggestedTimeoutMs).toBe(30_000);
    expect(waited).not.toHaveProperty('filesystemCheckpointed');
    expect(waited.allowedNextActions).toContain('forge_process_wait');
    expect(waited.next_step).toMatch(/each call observes for at most 30000ms/i);
    expect(waited.next_step).not.toMatch(/600000/);
    expect(record.processes[started.value.id]?.completedAt).toBeUndefined();
  });

  it('does not fake exitCode 0 when replaying a shell key linked to a managed process', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const started = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'shell-key-1:bg',
      expectedRevision: 1,
      approved: true
    });
    if ('replay' in started) throw new Error('Unexpected replay.');
    // Simulate timeout-conversion linking the original shell key to the process.
    record.idempotency['shell-key-1'] = {
      operationId: started.operationId,
      revision: record.workspace.revision,
      processId: started.value.id
    };
    const replayed = await service.exec(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      timeoutMs: 1_000,
      outputLimitBytes: 1_000,
      networkPolicy: 'package_install',
      idempotencyKey: 'shell-key-1',
      approved: true
    });
    expect(replayed).toMatchObject({
      replayed: true,
      status: 'started',
      managedProcess: { processId: started.value.id, status: 'running' }
    });
    expect(replayed).not.toMatchObject({ exitCode: 0 });
  });

  it('returns a running install instead of starting a second one (ChatGPT retry storm)', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    record.detection = {
      packageManager: 'pnpm',
      installCommand: 'pnpm install',
      installFallbackCommand: 'pnpm install',
      framework: 'vite',
      scripts: { dev: 'vite' }
    } as never;
    const first = await service.startProcess(record, {
      command: 'pnpm install',
      cwd: '/workspace/repo',
      networkPolicy: 'package_install',
      idempotencyKey: 'deps-active-1',
      expectedRevision: 1,
      approved: true
    });
    if ('replay' in first) throw new Error('Unexpected replay.');
    const second = await service.dependenciesInstall(record, {
      networkPolicy: 'package_install',
      idempotencyKey: 'deps-active-2',
      expectedRevision: 1,
      hostSafeWaitMs: 100
    });
    expect(second).toMatchObject({
      started: true,
      status: 'running',
      reusedActiveProcess: true,
      processId: first.value.id
    });
    expect(second.next_step).toMatch(/do not start another install|already running/i);
    expect(second.next_step).not.toMatch(/600000/);
    expect(second.next_step).toMatch(/at most 30000/);
  });

  it('returns host-safe running status when deps install outlives the short wait', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    record.detection = {
      packageManager: 'pnpm',
      installCommand: 'pnpm install',
      installFallbackCommand: 'pnpm install',
      framework: 'vite',
      scripts: { dev: 'vite' }
    } as never;
    const result = await service.dependenciesInstall(record, {
      networkPolicy: 'package_install',
      idempotencyKey: 'deps-host-safe-1',
      expectedRevision: 1,
      hostSafeWaitMs: 20
    });
    expect(result).toMatchObject({
      started: true,
      success: false,
      status: 'running',
      managedProcess: true
    });
    expect(result.processId).toMatch(/^proc_/);
    expect(result.allowedNextActions).toContain('forge_process_wait');
  });
});
