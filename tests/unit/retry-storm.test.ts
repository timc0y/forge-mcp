import { describe, expect, it } from 'vitest';
import { hashArgs } from '../../apps/forge-edge-gateway/src/telemetry';
import { reserveWorkspaceSlot } from '../../apps/forge-edge-gateway/src/capacity';

/**
 * forge_workspace_create failed fifteen times in two minutes against the
 * workspace quota, and the loop detector built to catch exactly that never
 * fired. This is why.
 */
describe('repeat detection sees intent, not attempts', () => {
  const intent = {
    repository: { provider: 'github', owner: 'timc0y', name: 'EasyRoads' },
    ref: 'forge/3adc07ad3283ce46',
    runtime: 'node-22',
    persistence: 'ephemeral'
  };

  it('gives two attempts at the same call the same hash', async () => {
    // Verified against D1: the fifteen failing calls had fifteen DISTINCT
    // args_hash values and byte-identical payloads. The only difference was a
    // freshly minted idempotency_key — the one field guaranteed to differ
    // between two attempts at the same thing, and therefore the one field that
    // must not feed the hash.
    const first = await hashArgs({ ...intent, idempotency_key: crypto.randomUUID() });
    const second = await hashArgs({ ...intent, idempotency_key: crypto.randomUUID() });
    const third = await hashArgs({ ...intent, idempotency_key: crypto.randomUUID() });

    expect(new Set([first, second, third]).size).toBe(1);
  });

  it('still separates calls that genuinely differ', async () => {
    // Stripping the key must not blur real differences, or the detector starts
    // suppressing distinct work instead of catching a storm.
    const baseline = await hashArgs({ ...intent, idempotency_key: 'a-key' });
    const otherRef = await hashArgs({ ...intent, ref: 'forge/other', idempotency_key: 'a-key' });
    const otherRepo = await hashArgs({
      ...intent,
      repository: { provider: 'github', owner: 'timc0y', name: 'forge-mcp' },
      idempotency_key: 'a-key'
    });

    expect(new Set([baseline, otherRef, otherRepo]).size).toBe(3);
  });

  it('handles a non-object input without throwing', async () => {
    await expect(hashArgs(undefined)).resolves.toEqual(expect.any(String));
    await expect(hashArgs(['a', 'b'])).resolves.toEqual(expect.any(String));
  });
});

/**
 * A D1 stub that answers by SQL shape: the slot claim finds nothing (quota
 * full), no existing slot for this workspace, five slots in use, and two
 * occupants whose repository and branch are known.
 */
function fullDatabase(): D1Database {
  const prepare = (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      first: async () => {
        if (sql.includes('RECURSIVE')) return null;
        if (sql.includes('SELECT slot FROM workspace_slots WHERE workspace_id')) return null;
        if (sql.includes('global_count')) return { global_count: 5, tenant_count: 5 };
        return null;
      },
      all: async () => ({
        results: [
          {
            slot: 1, tenant_id: 'ten_x', workspace_id: 'ws_a', claimed_at: new Date().toISOString(),
            state: 'ready', updated_at: new Date().toISOString(), has_unpushed_work: 0,
            repository: 'timc0y/EasyRoads', current_branch: 'forge/3adc07ad3283ce46'
          },
          {
            slot: 2, tenant_id: 'ten_x', workspace_id: 'ws_b', claimed_at: new Date().toISOString(),
            state: 'ready', updated_at: new Date().toISOString(), has_unpushed_work: 0,
            repository: 'timc0y/forge-mcp', current_branch: 'forge/abcd'
          }
        ]
      }),
      run: async () => ({ meta: { changes: 0 } })
    })
  });
  return { prepare } as unknown as D1Database;
}

describe('the quota refusal is actionable', () => {
  it('names the open workspaces and the tool that closes one', async () => {
    // The live failure: fifteen identical retries against "Finish or destroy
    // one, then retry" — a next step naming no tool and listing nothing, so
    // an agent that could not see its workspaces had nothing to act on.
    const error = await reserveWorkspaceSlot(fullDatabase(), 'ten_x', 'ws_new', {
      global: 20,
      perTenant: 5
    }).catch((caught: { message: string; details?: Record<string, unknown> }) => caught);

    const failure = error as { code?: string; message: string; details?: Record<string, unknown> };
    expect(failure.code).toBe('FORGE_QUOTA_EXCEEDED');
    expect(failure.message).toContain('forge_workspace_destroy');
    expect(failure.message).toContain('timc0y/EasyRoads on forge/3adc07ad3283ce46');
    expect(failure.message).toContain('timc0y/forge-mcp on forge/abcd');
    // And it must say plainly that repeating the call is not the way out.
    expect(failure.message).toMatch(/retrying this call unchanged will keep failing/u);
    expect(failure.details?.open_workspaces).toHaveLength(2);
  });
});
