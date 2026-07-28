import { describe, expect, it } from 'vitest';
import { ForgeApplicationService } from '@forge/application';
import type { ExecResult, SandboxHandle, SandboxProvider } from '@forge/sandbox-core';

function serviceWithProbe(stdout: string): ForgeApplicationService {
  const handle = {
    exec: async (): Promise<ExecResult> => ({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      durationMs: 1,
      artifactRefs: []
    })
  } as unknown as SandboxHandle;
  const provider = {
    kind: 'cloudflare',
    version: 'test',
    get: async () => handle
  } as unknown as SandboxProvider;
  return new ForgeApplicationService(provider);
}

function readyRecord(service: ForgeApplicationService) {
  const record = service.initializeWorkspace({
    tenantId: 'ten_00000000000000000000000000' as never,
    projectId: 'prj_00000000000000000000000000' as never,
    repository: { provider: 'github', owner: 'acme', name: 'app' },
    ref: 'main',
    runtimeProfile: 'node-22',
    persistence: 'ephemeral',
    bootstrap: false,
    idempotencyKey: 'seed-idempotency-key',
    actor: { type: 'agent', id: 'agent' }
  });
  record.workspace.state = 'ready';
  return record;
}

describe('checkout health verification', () => {
  it('marks the workspace failed when the checkout is missing', async () => {
    const service = serviceWithProbe('forge_checkout_missing\n');
    const record = readyRecord(service);
    await expect(service.assertCheckoutPresent(record)).rejects.toMatchObject({
      code: 'FORGE_WORKSPACE_NOT_READY'
    });
    expect(record.workspace.state).toBe('failed');
    expect(record.workspace.checkout?.healthy).toBe(false);
    expect(record.workspace.failure?.stage).toBe('checkout');
  });

  it('keeps a healthy workspace ready and records the probe', async () => {
    const service = serviceWithProbe('forge_checkout_present\n');
    const record = readyRecord(service);
    await expect(service.assertCheckoutPresent(record)).resolves.toBeUndefined();
    expect(record.workspace.state).toBe('ready');
    expect(record.workspace.checkout?.healthy).toBe(true);
  });

  it('does nothing for a workspace that is not in a repo-usable state', async () => {
    const service = serviceWithProbe('forge_checkout_missing\n');
    const record = readyRecord(service);
    record.workspace.state = 'provisioning';
    await expect(service.assertCheckoutPresent(record)).resolves.toBeUndefined();
    expect(record.workspace.state).toBe('provisioning');
  });
});
