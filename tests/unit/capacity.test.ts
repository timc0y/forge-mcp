import { describe, expect, it } from 'vitest';
import { reserveWorkspaceSlot } from '../../apps/forge-edge-gateway/src/capacity';

function database() {
  const claimed = new Map<string, number>();
  return {
    prepare: () => ({
      bind: (workspaceId: string) => ({
        run: async () => {
          if (!claimed.has(workspaceId) && claimed.size < 5) claimed.set(workspaceId, claimed.size + 1);
          return { meta: { changes: 1 } };
        },
        first: async () => claimed.has(workspaceId) ? { slot: claimed.get(workspaceId) } : null
      })
    })
  } as unknown as D1Database;
}

describe('workspace capacity', () => {
  it('allows five active Forge workspaces', async () => {
    const db = database();
    await expect(Promise.all([...Array(5)].map((_, index) => reserveWorkspaceSlot(db, `ws_${index}`)))).resolves.toEqual([1, 2, 3, 4, 5]);
    await expect(reserveWorkspaceSlot(db, 'ws_overflow')).rejects.toMatchObject({ code: 'FORGE_QUOTA_EXCEEDED', details: { maximum_workspaces: 5 } });
  });
});
