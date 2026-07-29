import { describe, expect, it } from 'vitest';
import { forgeStartSlug } from '../../apps/forge-edge-gateway/src/forge-start-branch';

describe('forge_start branch identity', () => {
  it('derives the same slug from the same caller idempotency key', async () => {
    const input = { tenantId: 't', projectId: 'p', owner: 'Acme', repo: 'App', idempotencyKey: 'retry-key-123' };
    expect(await forgeStartSlug(input)).toBe(await forgeStartSlug(input));
  });

  it('does not reuse a generated slug when no retry key was supplied', async () => {
    const base = { tenantId: 't', projectId: 'p', owner: 'acme', repo: 'app' };
    const first = await forgeStartSlug({ ...base, randomKey: () => 'first-random-key' });
    const second = await forgeStartSlug({ ...base, randomKey: () => 'second-random-key' });
    expect(first).not.toBe(second);
  });
});
