import { describe, expect, it } from 'vitest';
import { ForgeApplicationService } from '@forge/application';
import { ForgeError } from '@forge/core';
import type { PatchResult, SandboxHandle, SandboxProvider } from '@forge/sandbox-core';

function serviceReturning(patchResult: PatchResult): ForgeApplicationService {
  const handle = { applyPatch: async () => patchResult } as unknown as SandboxHandle;
  const provider = {
    kind: 'local-docker',
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

describe('forge_files_patch diagnostics', () => {
  it('reports rejected files and rollback when a patch does not apply', async () => {
    const service = serviceReturning({
      applied: false,
      output: 'error: patch failed: src/app.ts:12',
      changedFiles: [],
      rejectedFiles: ['src/app.ts'],
      rolledBack: true
    });
    const record = readyRecord(service);
    await expect(
      service.patch(record, { patch: 'x', cwd: '/workspace/repo' }, undefined, 'patch-key-1')
    ).rejects.toMatchObject({
      code: 'FORGE_PATCH_REJECTED',
      details: { rejectedFiles: ['src/app.ts'], rolledBack: true }
    });
  });

  it('returns the applied result when the patch is clean', async () => {
    const service = serviceReturning({
      applied: true,
      output: '',
      changedFiles: ['src/app.ts']
    });
    const record = readyRecord(service);
    const result = await service.patch(record, { patch: 'x', cwd: '/workspace/repo' }, undefined, 'patch-key-2');
    expect(result).toMatchObject({ value: { applied: true, changedFiles: ['src/app.ts'] } });
    expect(result).not.toBeInstanceOf(ForgeError);
  });
});
