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
  readonly handle: SandboxHandle = {
    providerId: 'fake',
    exec: async (input) => {
      this.calls.push(input.command);
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
        return { exitCode: 0, stdout: 'abcdef\nmain\n', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command === 'git status --porcelain=v2 --branch') {
        return { exitCode: 0, stdout: '# branch.head main\n', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      return { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
    },
    startProcess: async () => { throw new Error('unused'); },
    getProcess: async () => null,
    readProcessLogs: async () => ({ data: '', truncated: false }),
    stopProcess: async () => undefined,
    readFile: async () => { throw new Error('unused'); },
    writeFile: async () => { throw new Error('unused'); },
    applyPatch: async () => ({ applied: true, output: '', changedFiles: ['src/app.ts'] }),
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
  async snapshot() { throw new Error('unused'); }
  async restore() { throw new Error('unused'); }
}

function initialized(service: ForgeApplicationService): WorkspaceRuntimeRecord {
  return service.initializeWorkspace({
    workspaceId: ids.workspace(),
    tenantId: ids.tenant(),
    projectId: ids.project(),
    repository: { provider: 'github', owner: 'example', name: 'project' },
    ref: 'main',
    runtimeProfile: 'node-22',
    persistence: 'ephemeral',
    bootstrap: true,
    idempotencyKey: 'create-request-123',
    actor: { type: 'agent', id: 'tester' }
  });
}

describe('Forge application service', () => {
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

  it('separates destroy request from durable completion', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    record.workspace.state = 'ready';
    const request = service.requestDestroy(record, 1, 'destroy-123456');
    expect(request.state).toBe('destroying');
    await service.completeDestroy(record);
    expect(record.workspace.state).toBe('destroyed');
    expect(provider.calls).toContain('destroy');
  });
});
