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
      operationId: 'op_create'
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('force destroy skips reconciliation and mount-dependent safety checks', async () => {
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
    expect(requestDestroy).toHaveBeenCalledWith(record, undefined, 'force-destroy-test', true);
    expect(save).toHaveBeenCalledWith(record);
  });
});
