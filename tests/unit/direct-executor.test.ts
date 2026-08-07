import { describe, expect, it } from 'vitest';
import { ForgeError } from '@forge/core';
import { waitForDirectExecutorReady } from '../../apps/forge-edge-gateway/src/direct-executor';

const notReady = () => new ForgeError({
  code: 'FORGE_WORKSPACE_NOT_READY',
  message: 'private lifecycle detail',
  retryable: true,
  details: { workspace_id: 'ws_private', operation_id: 'op_private' }
});

describe('direct executor startup', () => {
  it('absorbs requested -> provisioning -> ready without a caller poll', async () => {
    const states = ['requested', 'provisioning', 'ready'];
    let starts = 0;
    await waitForDirectExecutorReady(
      async () => {
        starts += 1;
        if (starts < 3) throw notReady();
      },
      async () => ({ state: states[Math.min(starts - 1, states.length - 1)] ?? 'ready' }),
      { pollMs: 1, sleep: async () => undefined }
    );
    expect(starts).toBe(3);
  });

  it('returns a bounded public error when startup never becomes ready', async () => {
    let clock = 0;
    await expect(waitForDirectExecutorReady(
      async () => { throw notReady(); },
      async () => ({ state: 'provisioning' }),
      { timeoutMs: 5, pollMs: 2, now: () => clock, sleep: async (ms) => { clock += ms; } }
    )).rejects.toMatchObject({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: expect.stringContaining('same repository and branch'),
      details: { allowedNextActions: ['forge_run', 'forge_screenshot'] }
    });
  });

  it('does not retry a terminal failure with private recovery instructions', async () => {
    await expect(waitForDirectExecutorReady(
      async () => { throw notReady(); },
      async () => ({ state: 'failed' }),
      { sleep: async () => undefined }
    )).rejects.toMatchObject({
      message: expect.not.stringMatching(/workspace_id|operation_id|forge_workspace_get/iu),
      details: { allowedNextActions: ['forge_run', 'forge_screenshot'] }
    });
  });
});
