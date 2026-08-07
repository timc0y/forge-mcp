import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntimeRecord } from '@forge/application';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  }
}));
vi.mock('@forge/sandbox-cloudflare', () => ({
  CloudflareSandboxProvider: class {}
}));
vi.mock('../../packages/sandbox-cloudflare/src/index.ts', () => ({
  CloudflareSandboxProvider: class {}
}));

import { WorkspaceCoordinator } from '../../apps/forge-edge-gateway/src/workspace-coordinator';

describe('workspace coordinator recovery paths', () => {
  it('reads authorization binding from metadata storage without touching the sandbox', async () => {
    const record = {
      workspace: {
        tenantId: 'ten_owner',
        projectId: 'prj_owner',
        state: 'failed',
        repository: { provider: 'github', owner: 'octocat', name: 'hello-world' },
        requestedRef: 'main',
        currentBranch: 'forge/test',
        revision: 7
      },
      idempotency: { create: { operationId: 'op_create', revision: 1 } }
    } as WorkspaceRuntimeRecord;
    const get = vi.fn(async () => record);
    const getAuthorizationBinding = (WorkspaceCoordinator.prototype as unknown as {
      getAuthorizationBinding(this: unknown): Promise<Record<string, unknown>>;
    }).getAuthorizationBinding;

    await expect(getAuthorizationBinding.call({ ctx: { storage: { get } } })).resolves.toEqual({
      tenantId: 'ten_owner',
      projectId: 'prj_owner',
      state: 'failed',
      repository: { provider: 'github', owner: 'octocat', name: 'hello-world' },
      requestedRef: 'main',
      currentBranch: 'forge/test',
      revision: 7,
      bootstrapRequested: true,
      executorSyncPending: false,
      githubEditInProgress: false,
      operationId: 'op_create'
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('defers a GitHub commit while a mutating executor process is active', async () => {
    const record = {
      workspace: {
        id: 'ws_test',
        state: 'ready',
        currentCommit: 'old',
        currentBranch: 'forge/test',
        revision: 7
      },
      processes: {
        proc_live: { command: 'pnpm test', startedAt: new Date().toISOString(), mutatesFilesystem: true }
      },
      executorCommit: 'old',
      githubEditInProgress: {
        token: 'edit_test',
        branch: 'forge/test',
        intentHash: 'intent',
        startedAt: new Date().toISOString()
      }
    } as unknown as WorkspaceRuntimeRecord;
    const save = vi.fn(async () => undefined);
    const coordinator = {
      serializeMutation: async (action: () => Promise<unknown>) => action(),
      getRecord: async () => record,
      syncPendingRemoteCommit: vi.fn(async () => false),
      save
    };

    await expect(WorkspaceCoordinator.prototype.recordGitHubCommit.call(coordinator as never, {
      token: 'edit_test',
      commit: 'new',
      branch: 'forge/test'
    })).resolves.toMatchObject({ executorSynced: false });
    expect(record.workspace.currentCommit).toBe('new');
    expect(record.executorCommit).toBe('old');
    expect(record.pendingRemoteCommit).toMatchObject({ commit: 'new', branch: 'forge/test' });
    expect(save).toHaveBeenCalledWith(record);
  });

  it('replays a lost recordGitHubCommit response by edit token without advancing GitHub state twice', async () => {
    const record = {
      workspace: {
        id: 'ws_test',
        state: 'ready',
        currentCommit: 'new',
        currentBranch: 'forge/test',
        revision: 8
      },
      processes: {},
      executorCommit: 'old',
      pendingRemoteCommit: {
        commit: 'new', branch: 'forge/test', recordedAt: new Date().toISOString(), invalidateDependencies: false
      },
      lastRecordedGitHubEdit: { token: 'edit_test', commit: 'new', branch: 'forge/test' }
    } as unknown as WorkspaceRuntimeRecord;
    const save = vi.fn(async () => undefined);
    const coordinator = {
      serializeMutation: async (action: () => Promise<unknown>) => action(),
      getRecord: async () => record,
      syncPendingRemoteCommit: vi.fn(async () => false),
      save
    };

    await expect(WorkspaceCoordinator.prototype.recordGitHubCommit.call(coordinator as never, {
      token: 'edit_test', commit: 'new', branch: 'forge/test'
    })).resolves.toMatchObject({ executorSynced: false, replayed: true, revision: 8 });
    expect(record.workspace.revision).toBe(8);
    expect(coordinator.syncPendingRemoteCommit).toHaveBeenCalledTimes(1);
  });

  it('blocks executor starts while a GitHub edit token is unresolved', async () => {
    const record = {
      workspace: { id: 'ws_test', currentCommit: 'old' },
      processes: {},
      githubEditInProgress: {
        token: 'edit_test', branch: 'forge/test', intentHash: 'intent', startedAt: new Date().toISOString()
      }
    } as unknown as WorkspaceRuntimeRecord;
    const prepareExecution = (WorkspaceCoordinator.prototype as unknown as {
      prepareExecution(this: unknown, record: WorkspaceRuntimeRecord): Promise<void>;
    }).prepareExecution;

    await expect(prepareExecution.call({}, record)).rejects.toMatchObject({
      code: 'FORGE_WORKSPACE_CONFLICT',
      message: expect.stringContaining('forge_workspace_destroy')
    });
  });

  it('destroy skips reconciliation and mount-dependent safety checks', async () => {
    const record = { workspace: { id: 'ws_test' } } as WorkspaceRuntimeRecord;
    const reconcileGitState = vi.fn(async () => { throw new Error('mount missing'); });
    const requestDestroy = vi.fn(() => ({ state: 'destroying' }));
    const save = vi.fn(async () => undefined);
    const coordinator = {
      serializeMutation: async (action: () => Promise<unknown>) => action(),
      getRecord: async () => record,
      durablePushBeforeTeardown: vi.fn(async () => undefined),
      app: { reconcileGitState, requestDestroy },
      save
    };

    await expect(WorkspaceCoordinator.prototype.requestDestroy.call(coordinator as never, {
      idempotencyKey: 'force-destroy-test',
      force: true
    })).resolves.toMatchObject({ state: 'destroying' });
    expect(reconcileGitState).not.toHaveBeenCalled();
    expect(requestDestroy).toHaveBeenCalledWith(record, undefined, 'force-destroy-test');
    expect(save).toHaveBeenCalledWith(record);
  });

  it('starts a configured nested preview in its configured cwd and port', async () => {
    const record = {
      workspace: { id: 'ws_preview', state: 'ready' },
      detection: {
        devCommand: 'pnpm dev --host 0.0.0.0',
        devCwd: '/workspace/repo/apps/web',
        expectedPorts: [4173],
        previewConfig: { cwd: 'apps/web', command: 'pnpm dev --host 0.0.0.0', port: 4173 },
        previewConfigError: null
      },
      processes: {},
      previews: {}
    } as unknown as WorkspaceRuntimeRecord;
    const startProcess = vi.fn(async (_current: unknown, input: { command: string; cwd: string }) => ({
      value: { id: 'proc_preview' },
      operationId: 'op_preview',
      replayed: false,
      ...input
    }));
    const exposePreview = vi.fn(async () => ({ previewId: 'prv_preview', expiresAt: '2099-01-01T00:00:00.000Z' }));
    const save = vi.fn(async () => undefined);
    const coordinator = {
      serializeMutation: async (action: () => Promise<unknown>) => action(),
      getRecord: async () => record,
      prepareExecution: vi.fn(async () => undefined),
      app: { startProcess, exposePreview },
      save
    };

    await expect(WorkspaceCoordinator.prototype.startReviewPreview.call(coordinator as never, {
      hostname: 'preview.forge.test',
      ttlSeconds: 600
    })).resolves.toMatchObject({ ready: true, previewId: 'prv_preview', port: 4173 });
    expect(startProcess).toHaveBeenCalledWith(record, expect.objectContaining({
      command: 'pnpm dev --host 0.0.0.0',
      cwd: '/workspace/repo/apps/web',
      networkPolicy: 'development'
    }));
    expect(exposePreview).toHaveBeenCalledWith(record, expect.objectContaining({ processId: 'proc_preview', port: 4173 }));
    expect(save).toHaveBeenCalledWith(record);
  });

  it('refuses an invalid repository preview config without starting a process', async () => {
    const record = {
      workspace: { id: 'ws_invalid_preview', state: 'ready' },
      detection: {
        devCommand: 'pnpm run dev',
        devCwd: '/workspace/repo',
        expectedPorts: [5173],
        previewConfigError: 'Forge config preview.cwd must stay inside the repository.'
      },
      processes: {},
      previews: {}
    } as unknown as WorkspaceRuntimeRecord;
    const startProcess = vi.fn();
    const coordinator = {
      serializeMutation: async (action: () => Promise<unknown>) => action(),
      getRecord: async () => record,
      prepareExecution: vi.fn(async () => undefined),
      app: { startProcess },
      save: vi.fn(async () => undefined)
    };

    await expect(WorkspaceCoordinator.prototype.startReviewPreview.call(coordinator as never, {
      hostname: 'preview.forge.test',
      ttlSeconds: 600
    })).resolves.toEqual({ ready: false, reason: 'Forge config preview.cwd must stay inside the repository.' });
    expect(startProcess).not.toHaveBeenCalled();
  });

  it('refreshes project detection after a durable preview config edit', async () => {
    const record = {
      workspace: { id: 'ws_refresh_preview', state: 'ready' },
      detection: undefined,
      processes: {},
      previews: {}
    } as unknown as WorkspaceRuntimeRecord;
    const startProcess = vi.fn(async () => ({ value: { id: 'proc_refresh' }, operationId: 'op_refresh', replayed: false }));
    const refreshDetection = vi.fn(async (current: WorkspaceRuntimeRecord) => {
      current.detection = {
        devCommand: 'node server.js',
        devCwd: '/workspace/repo/apps/web',
        expectedPorts: [8080],
        previewConfigError: null
      } as never;
      return current.detection;
    });
    const coordinator = {
      serializeMutation: async (action: () => Promise<unknown>) => action(),
      getRecord: async () => record,
      prepareExecution: vi.fn(async () => undefined),
      app: {
        startProcess,
        exposePreview: vi.fn(async () => ({ previewId: 'prv_refresh', expiresAt: '2099-01-01T00:00:00.000Z' })),
        refreshDetection
      },
      save: vi.fn(async () => undefined)
    };

    await expect(WorkspaceCoordinator.prototype.startReviewPreview.call(coordinator as never, {
      hostname: 'preview.forge.test',
      ttlSeconds: 600
    })).resolves.toMatchObject({ ready: true, previewId: 'prv_refresh', port: 8080 });
    expect(refreshDetection).toHaveBeenCalledWith(record);
    expect(startProcess).toHaveBeenCalledWith(record, expect.objectContaining({
      command: 'node server.js',
      cwd: '/workspace/repo/apps/web'
    }));
  });
});
