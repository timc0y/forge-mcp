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
  branch = 'main';
  workspacePresent = true;
  workspaceMarkerPresent = true;
  workspaceOtherContentPresent = false;
  workspaceProbeFails = false;
  worktreeDiff = '';
  workspaceHash = 'a'.repeat(64);
  private commitSequence = 0;
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
      if (input.command.includes('===FORGE_HEAD===')) {
        return {
          exitCode: 0,
          stdout: [
            '===FORGE_HEAD===',
            this.head,
            '===FORGE_BRANCH===',
            this.branch,
            '===FORGE_LOCKFILE===',
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
      if (input.command.includes('test ! -e /workspace/repo && test ! -e /workspace/forge/workspace-id')) {
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
      if (input.command.includes('tar --sort=name --format=posix')) {
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
        return { exitCode: 0, stdout: `# branch.head main\n${this.head}\nmain\n`, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command === 'git diff --no-ext-diff --binary && git diff --cached --no-ext-diff --binary') {
        return { exitCode: 0, stdout: this.worktreeDiff, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
      }
      if (input.command === 'npm install') {
        return { exitCode: this.install.lenient ?? 0, stdout: '', stderr: 'install failed', truncated: false, durationMs: 1, artifactRefs: [] };
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

  constructor(
    private readonly createError?: Error,
    private readonly install: { strict?: number; lenient?: number } = {}
  ) {}

  async create(_input: CreateSandboxInput) {
    if (this.createError) throw this.createError;
    return this.handle;
  }
  async get() { return this.handle; }
  async suspend() {}
  async resume() { return this.handle; }
  async destroy() { this.calls.push('destroy'); }
  async snapshot() { return { id: ids.snapshot(), providerSnapshotId: 'snapshot', providerVersion: this.version, createdAt: new Date().toISOString() }; }
  async restore(snapshot: Parameters<SandboxProvider['restore']>[0]) {
    this.calls.push('restore');
    const manifest = (snapshot as { manifest?: { commit?: string; branch?: string } }).manifest;
    if (manifest?.commit) this.head = manifest.commit;
    if (manifest?.branch !== undefined) this.branch = manifest.branch;
    this.workspacePresent = true;
    this.workspaceMarkerPresent = true;
    return this.handle;
  }
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
    expect(record.workspace.activeSnapshotId).toBeDefined();
    expect(Object.keys(record.snapshots)).toHaveLength(1);
    expect(provider.calls).toContain('npm ci');
  });

  it('restores its active checkpoint before exposing a workspace after a sandbox restart', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    provider.workspacePresent = false;

    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .resolves.toMatchObject({ entries: [] });
    expect(provider.calls).toContain('restore');
    expect(record.processes).toEqual({});
    expect(record.previews).toEqual({});
  });

  it('never restores over a workspace whose marker is missing but repository mount remains', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    provider.workspaceMarkerPresent = false;

    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'FORGE_PROVIDER_UNAVAILABLE' });
    expect(provider.calls).not.toContain('restore');
  });

  it('never restores when any other snapshot-target content remains mounted', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    provider.workspacePresent = false;
    provider.workspaceOtherContentPresent = true;

    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'FORGE_PROVIDER_UNAVAILABLE' });
    expect(provider.calls).not.toContain('restore');
  });

  it('upgrades a legacy checkpoint only after a confirmed mount-loss restore', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    const snapshotId = record.workspace.activeSnapshotId!;
    delete record.snapshots[snapshotId]!.manifest;
    provider.workspacePresent = false;

    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .resolves.toMatchObject({ entries: [] });
    expect(record.snapshots[snapshotId]?.manifest).toMatchObject({ commit: 'abcdef', branch: 'main' });
  });

  it('never restores when the workspace probe itself is unavailable', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    provider.workspaceProbeFails = true;

    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'FORGE_PROVIDER_UNAVAILABLE' });
    expect(provider.calls).not.toContain('restore');
  });

  it('never restores over a live Git divergence', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    provider.head = 'different-commit';

    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED' });
    expect(provider.calls).not.toContain('restore');
  });

  it('rejects a restored filesystem that does not match its checkpoint manifest', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    await service.provisionWorkspace(record, false);
    provider.workspacePresent = false;
    provider.workspaceHash = 'b'.repeat(64);

    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'FORGE_SNAPSHOT_INCOMPATIBLE' });
    expect(provider.calls).toContain('restore');
    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'FORGE_WORKSPACE_NOT_READY' });
  });

  it('keeps a detached checkout distinct from a checked-out branch', async () => {
    const provider = new FakeProvider();
    provider.branch = '';
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    record.workspace.requestedRef = 'v1.0.0';

    await service.provisionWorkspace(record, false);
    expect(record.workspace.currentBranch).toBeUndefined();
    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .resolves.toMatchObject({ entries: [] });
    expect(provider.calls).not.toContain('restore');
  });

  it('rejects an external branch checkout even when detached HEAD stays on the same commit', async () => {
    const provider = new FakeProvider();
    provider.branch = '';
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    record.workspace.requestedRef = 'v1.0.0';
    await service.provisionWorkspace(record, false);
    provider.branch = 'main';

    await expect(service.tree(record, { path: '/workspace/repo', depth: 1, limit: 10 }))
      .rejects.toMatchObject({ code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED' });
    expect(provider.calls).not.toContain('restore');
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

  it('replays a patch idempotently without applying twice', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    ready(record);
    const first = await service.patch(record, { cwd: '/workspace/repo', patch: 'patch' }, 1, 'patch-123456');
    const second = await service.patch(record, { cwd: '/workspace/repo', patch: 'patch' }, undefined, 'patch-123456');
    expect(first).toMatchObject({ workspaceRevision: 2 });
    expect(second).toMatchObject({ replay: true, operationId: first.operationId });
  });

  it('acknowledges a whole-file write only after the same workspace can read it', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    const result = await service.write(record, { path: '/workspace/repo/src/main.ts', content: 'export const value = 1;' }, 1, 'write-123456');
    expect(result).toMatchObject({ workspaceId: record.workspace.id, path: '/workspace/repo/src/main.ts', previousSha256: null, readAfterWriteVerified: true, filesystemRevision: 2 });
    expect((await provider.handle.readFile({ path: '/workspace/repo/src/main.ts', maxBytes: 100 })).content).toBe('export const value = 1;');
  });

  it('records a provider checkpoint outside the mutable worktree record', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    ready(record);
    const checkpoint = await service.checkpoint(record, 'before-submit');
    expect(record.workspace.activeSnapshotId).toBe(checkpoint.snapshotId);
    expect(record.snapshots[checkpoint.snapshotId]).toMatchObject({
      manifest: { commit: 'abcdef', branch: 'main' }
    });
  });

  it('adopts only Forge-owned branch and commit transitions', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    record.workspace.currentCommit = 'abcdef';
    record.workspace.currentBranch = 'main';

    await expect(service.gitBranchCreate(record, 'forge/recovery-receipt', 1, 'branch-123456'))
      .resolves.toMatchObject({ branch: 'forge/recovery-receipt' });
    expect(record.workspace.currentBranch).toBe('forge/recovery-receipt');

    await expect(service.gitCommit(record, { message: 'Record a durable transition', paths: ['.'], expectedRevision: 2, idempotencyKey: 'commit-123456' }))
      .resolves.toMatchObject({ commit: '1'.repeat(40), branch: 'forge/recovery-receipt' });
    expect(record.lastGitDivergence).toBeUndefined();
  });

  it('restores a checkpoint only when newer local work is safe', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    ready(record);
    record.workspace.currentCommit = 'abcdef';
    record.workspace.currentBranch = 'main';
    record.workspace.lastPushedCommit = 'abcdef';
    record.workspace.lastPushedBranch = 'main';
    const checkpoint = await service.checkpoint(record);
    await expect(service.restoreCheckpoint(record, checkpoint.snapshotId)).resolves.toMatchObject({ restoredSnapshotId: checkpoint.snapshotId, branch: 'main' });
  });

  it('records the selected checkpoint identity only after its filesystem is verified', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    record.workspace.currentCommit = 'abcdef';
    record.workspace.currentBranch = 'main';
    record.workspace.lastPushedCommit = 'abcdef';
    record.workspace.lastPushedBranch = 'main';
    const checkpoint = await service.checkpoint(record, 'before-newer-commit');
    provider.head = 'newer-commit';
    record.workspace.currentCommit = 'newer-commit';
    record.workspace.lastPushedCommit = 'newer-commit';

    await expect(service.restoreCheckpoint(record, checkpoint.snapshotId)).resolves.toMatchObject({
      restoredSnapshotId: checkpoint.snapshotId,
      commit: 'abcdef',
      branch: 'main'
    });
    expect(record.workspace).toMatchObject({ currentCommit: 'abcdef', currentBranch: 'main' });
    expect(record.lastGitDivergence).toBeUndefined();
  });

  it('blocks checkpoint restoration when Git reveals an unpushed commit created outside cached metadata', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
    record.workspace.currentCommit = 'abcdef';
    record.workspace.currentBranch = 'main';
    record.workspace.lastPushedCommit = 'abcdef';
    record.workspace.lastPushedBranch = 'main';
    const checkpoint = await service.checkpoint(record);
    provider.head = 'new-local-commit';
    await expect(service.restoreCheckpoint(record, checkpoint.snapshotId)).rejects.toMatchObject({ code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED' });
    expect(record.lastGitDivergence).toMatchObject({ observedCommit: 'new-local-commit', observedBranch: 'main' });
  });

  it('turns a long-running validation into a durable check with a process handle', async () => {
    const service = new ForgeApplicationService(new FakeProvider());
    const record = initialized(service);
    ready(record);
    const started = await service.startCheck(record, { name: 'unit tests', command: 'pnpm test', cwd: '/workspace/repo', networkPolicy: 'development', idempotencyKey: 'check-123456', expectedRevision: 1 });
    if ('replay' in started) throw new Error('Unexpected check replay.');
    const check = await service.checkGet(record, started.value.id);
    expect(check).toMatchObject({ workspaceId: record.workspace.id, process: { status: 'running' }, check: { name: 'unit tests', command: 'pnpm test' } });
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

  it('separates destroy request from durable completion', async () => {
    const provider = new FakeProvider();
    const service = new ForgeApplicationService(provider);
    const record = initialized(service);
    ready(record);
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
    ready(record);
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
