import { describe, expect, it } from 'vitest';
import { ForgeApplicationService, type WorkspaceRuntimeRecord } from '@forge/application';
import { ForgeError, ids } from '@forge/core';
import type {
  CreateSandboxInput,
  SandboxHandle,
  SandboxProvider
} from '@forge/sandbox-core';

class FakeProvider implements SandboxProvider {
  readonly kind = 'local-docker' as const;
  readonly version = 'test';
  readonly calls: string[] = [];
  readonly files = new Map<string, string>();
  head = 'abcdef';
  readonly handle: SandboxHandle = {
    providerId: 'fake',
    exec: async (input) => {
      this.calls.push(input.command);
      if (input.command === 'node --version && corepack --version') {
        return { exitCode: 0, stdout: 'v24.12.0\n0.34.1\n', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.startsWith('git clone')) {
        return { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.includes("console.log(JSON.stringify")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ pm: 'npm', framework: 'vite', scripts: { dev: 'vite', build: 'vite build' } }),
          stderr: '', truncated: false, durationMs: 1, artifactRefs: []
        };
      }
      if (input.command === 'npm ci') {
        return { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.startsWith('git rev-parse')) {
        return { exitCode: 0, stdout: `${this.head}\nmain\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.startsWith('git status --porcelain=v2 --branch &&')) {
        return { exitCode: 0, stdout: `# branch.head main\n${this.head}\nmain\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command === 'git status --porcelain=v2 --branch') {
        return { exitCode: 0, stdout: '# branch.head main\n', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command.startsWith('git ls-remote --exit-code origin ')) {
        return { exitCode: 0, stdout: `${this.head}\trefs/heads/main\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
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
    startProcess: async (input) => ({ id: input.processId, providerProcessId: 'provider-process', command: input.command, cwd: input.cwd, status: 'running' as const, pid: 123 }),
    getProcess: async (processId) => ({ id: processId, providerProcessId: 'provider-process', command: 'pnpm test', cwd: '/workspace/repo', status: 'running' as const, pid: 123 }),
    readProcessLogs: async () => ({ data: '', truncated: false }),
    stopProcess: async () => undefined,
    readFile: async ({ path, maxBytes }) => {
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
    applyPatch: async () => { this.files.set('/workspace/repo/src/app.ts', 'patched'); return { applied: true, output: '', changedFiles: ['src/app.ts'] }; },
    listFiles: async () => ({ entries: [], truncated: false }),
    exposePort: async () => ({ port: 5173, providerUrl: 'https://provider.invalid', name: 'preview' }),
    revokePort: async () => undefined
  };

  constructor(private readonly createError?: Error) {}

  async create(_input: CreateSandboxInput) {
    if (this.createError) throw this.createError;
    return this.handle;
  }
  async get() { return this.handle; }
  async suspend() {}
  async resume() { return this.handle; }
  async destroy() { this.calls.push('destroy'); }
  async snapshot() { return { id: ids.snapshot(), providerSnapshotId: 'snapshot', providerVersion: this.version, createdAt: new Date().toISOString() }; }
  async restore() { return this.handle; }
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

describe('Forge application service', () => {
  it('rejects client operations until provisioning has completed', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);

    record.workspace.state = 'provisioning';
    await expect(service.read(record, { path: '/workspace/repo/README.md', maxBytes: 1_000 }))
      .rejects.toMatchObject({ code: 'FORGE_WORKSPACE_NOT_READY' });

    record.workspace.state = 'bootstrapping';
    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'FORGE_WORKSPACE_NOT_READY' });
  });

  it('provisions through explicit lifecycle states', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    const states: string[] = [];
    await service.provisionWorkspace(record, true, async (next) => {
      states.push(next.workspace.state);
    });
    expect(states).toEqual(['provisioning', 'bootstrapping', 'ready']);
    expect(record.workspace).toMatchObject({ currentCommit: 'abcdef', currentBranch: 'main', state: 'ready' });
    expect(provider.calls).toContain('npm ci');
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

  it('replays a patch idempotently without applying twice', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    record.workspace.state = 'ready';
    const first = await service.patch(record, { cwd: '/workspace/repo', patch: 'patch' }, 1, 'patch-123456');
    const second = await service.patch(record, { cwd: '/workspace/repo', patch: 'patch' }, undefined, 'patch-123456');
    expect(first).toMatchObject({ workspaceRevision: 2 });
    expect(second).toMatchObject({ replay: true, operationId: first.operationId });
  });

  it('acknowledges a whole-file write only after the same workspace can read it', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    record.workspace.state = 'ready';
    const result = await service.write(record, { path: '/workspace/repo/src/main.ts', content: 'export const value = 1;' }, 1, 'write-123456');
    expect(result).toMatchObject({ workspaceId: record.workspace.id, path: '/workspace/repo/src/main.ts', previousSha256: null, readAfterWriteVerified: true, filesystemRevision: 2 });
    expect((await provider.handle.readFile({ path: '/workspace/repo/src/main.ts', maxBytes: 100 })).content).toBe('export const value = 1;');
  });

  it('records a provider checkpoint outside the mutable worktree record', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    record.workspace.state = 'ready';
    const checkpoint = await service.checkpoint(record, 'before-submit');
    expect(record.workspace.activeSnapshotId).toBe(checkpoint.snapshotId);
    expect(record.snapshots[checkpoint.snapshotId]).toBeDefined();
  });

  it('restores a checkpoint only when newer local work is safe', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    record.workspace.state = 'ready';
    record.workspace.currentCommit = 'abcdef';
    record.workspace.currentBranch = 'main';
    record.workspace.lastPushedCommit = 'abcdef';
    record.workspace.lastPushedBranch = 'main';
    const checkpoint = await service.checkpoint(record);
    await expect(service.restoreCheckpoint(record, checkpoint.snapshotId)).resolves.toMatchObject({ restoredSnapshotId: checkpoint.snapshotId, branch: 'main' });
  });

  it('blocks checkpoint restoration when Git reveals an unpushed commit created outside cached metadata', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    record.workspace.state = 'ready';
    record.workspace.currentCommit = 'abcdef';
    record.workspace.currentBranch = 'main';
    record.workspace.lastPushedCommit = 'abcdef';
    record.workspace.lastPushedBranch = 'main';
    const checkpoint = await service.checkpoint(record);
    provider.head = 'new-local-commit';
    await expect(service.restoreCheckpoint(record, checkpoint.snapshotId)).rejects.toMatchObject({ code: 'FORGE_GIT_PUSH_BLOCKED' });
    expect(record.workspace.currentCommit).toBe('new-local-commit');
  });

  it('turns a long-running validation into a durable check with a process handle', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    record.workspace.state = 'ready';
    const started = await service.startCheck(record, { name: 'unit tests', command: 'pnpm test', cwd: '/workspace/repo', networkPolicy: 'development', idempotencyKey: 'check-123456', expectedRevision: 1 });
    if ('replay' in started) throw new Error('Unexpected check replay.');
    const check = await service.checkGet(record, started.value.id);
    expect(check).toMatchObject({ workspaceId: record.workspace.id, process: { status: 'running' }, check: { name: 'unit tests', command: 'pnpm test' } });
  });

  it('only stops a process that belongs to the explicit workspace', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    record.workspace.state = 'ready';
    const started = await service.startProcess(record, { command: 'pnpm dev', cwd: '/workspace/repo', networkPolicy: 'development', idempotencyKey: 'process-123456', expectedRevision: 1 });
    if ('replay' in started) throw new Error('Unexpected process replay.');
    await expect(service.stopProcess(record, started.value.id, undefined, 'stop-123456')).resolves.toMatchObject({ stopped: true, processId: started.value.id });
    await expect(service.stopProcess(record, started.value.id, undefined, 'stop-123457')).rejects.toMatchObject({ code: 'FORGE_PROCESS_NOT_FOUND' });
  });

  it('separates destroy request from durable completion', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    record.workspace.state = 'ready';
    record.workspace.currentCommit = 'abcdef';
    record.workspace.currentBranch = 'main';
    record.workspace.lastPushedCommit = 'abcdef';
    record.workspace.lastPushedBranch = 'main';
    const request = service.requestDestroy(record, 1, 'destroy-123456');
    expect(request.state).toBe('destroying');
    await service.completeDestroy(record);
    expect(record.workspace.state).toBe('destroyed');
    expect(provider.calls).toContain('destroy');
  });

  it('rechecks actual Git immediately before workspace teardown', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    record.workspace.state = 'ready';
    record.workspace.currentCommit = 'abcdef';
    record.workspace.currentBranch = 'main';
    record.workspace.lastPushedCommit = 'abcdef';
    record.workspace.lastPushedBranch = 'main';
    service.requestDestroy(record, 1, 'destroy-123456');
    provider.head = '1234567';
    await expect(service.completeDestroy(record)).rejects.toMatchObject({ code: 'FORGE_GIT_PUSH_BLOCKED' });
    expect(record.workspace.state).toBe('destroying');
  });
});
