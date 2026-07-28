import { describe, expect, it } from 'vitest';
import { ForgeApplicationService } from '@forge/application';
import type { SandboxHandle, SandboxProvider } from '@forge/sandbox-core';

/**
 * Two agents met "Workspace is failed." on this exact path, concluded the
 * GitHub App had read-only access — it has contents:write — and announced they
 * were switching to a "read-only workspace" that has never existed. Neither
 * invention was possible from the facts; both were reachable from a message
 * that gave no cause and no next step.
 */
function serviceWithFailedWorkspace(failure?: {
  stage: string;
  code: string;
  message: string;
  retryable: boolean;
}) {
  const service = new ForgeApplicationService({
    kind: 'cloudflare',
    version: 'test',
    get: async () => ({ exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, artifactRefs: [] }) }) as unknown as SandboxHandle
  } as unknown as SandboxProvider);
  const record = service.initializeWorkspace({
    tenantId: 'ten_00000000000000000000000000' as never,
    projectId: 'prj_00000000000000000000000000' as never,
    repository: { provider: 'github', owner: 'timc0y', name: 'forge-mcp' },
    ref: 'main',
    runtimeProfile: 'node-24',
    persistence: 'ephemeral',
    bootstrap: false,
    idempotencyKey: 'seed-idempotency-key',
    actor: { type: 'agent', id: 'agent' }
  });
  record.workspace.state = 'failed';
  if (failure) record.workspace.failure = failure;
  return { service, record };
}

async function refusal(record: ReturnType<typeof serviceWithFailedWorkspace>['record'], service: ForgeApplicationService) {
  try {
    await service.read(record, { path: '/workspace/repo/a.ts', maxBytes: 100 });
    throw new Error('expected a refusal');
  } catch (error) {
    return error as { code?: string; message: string; retryable?: boolean; details?: Record<string, unknown> };
  }
}

describe('an unusable workspace explains itself', () => {
  it('carries the stored provisioning reason instead of discarding it', async () => {
    const { service, record } = serviceWithFailedWorkspace({
      stage: 'provision',
      code: 'FORGE_SANDBOX_TIMEOUT',
      message: 'The container did not become reachable within the provisioning budget.',
      retryable: false
    });

    const error = await refusal(record, service);

    expect(error.code).toBe('FORGE_WORKSPACE_NOT_READY');
    expect(error.message).toContain('provision');
    expect(error.message).toContain('did not become reachable');
    expect(error.details).toMatchObject({ failure_code: 'FORGE_SANDBOX_TIMEOUT' });
  });

  it('rules out the two things agents invented when it said nothing', async () => {
    const { service, record } = serviceWithFailedWorkspace();

    const error = await refusal(record, service);

    // Both inventions, refused by name: it is not a permissions fault, and
    // there is no degraded mode to continue in.
    expect(error.message).toMatch(/not a repository permission problem/iu);
    expect(error.message).toMatch(/no read-only or degraded mode/iu);
    // And it says what to do instead, so the dead end has an exit.
    expect(error.message).toContain('forge_workspace_create');
    expect(error.retryable).toBe(false);
  });

  it('tells a still-starting workspace apart from a dead one', async () => {
    const { service, record } = serviceWithFailedWorkspace();
    record.workspace.state = 'provisioning';

    const error = await refusal(record, service);

    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/still starting/iu);
    // The failure mode this heads off: a second workspace, with the first
    // still holding the work.
    expect(error.message).toMatch(/do not create a second workspace/iu);
  });
});
