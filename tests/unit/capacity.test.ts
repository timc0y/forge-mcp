import { describe, expect, it } from 'vitest';
import {
  listSlotOccupants,
  reclaimStaleSlots,
  releaseWorkspaceSlot,
  reserveWorkspaceSlot,
  slotTtlMs,
  workspaceCaps
} from '../../apps/forge-edge-gateway/src/capacity';

interface SlotRow {
  slot: number;
  tenant_id: string;
  workspace_id: string;
  claimed_at: string;
}
interface WorkspaceRow {
  state: string;
  updated_at: string;
  has_unpushed_work?: number;
}

// Minimal in-memory D1 that understands only the statements capacity.ts issues.
function fakeD1(slots: SlotRow[], workspaces: Record<string, WorkspaceRow>) {
  return {
    slots,
    prepare(sql: string) {
      let values: unknown[] = [];
      // Bind order for the reserve statement: perTenant, workspaceId, tenantId, now, globalCap.
      const claim = (): number | null => {
        const [perTenant, workspaceId, tenantId, claimedAt, globalCap] = values as [number, string, string, string, number];
        if (slots.some((slot) => slot.workspace_id === workspaceId)) return null; // ON CONFLICT DO NOTHING
        if (slots.length >= globalCap) return null;
        const tenantSlots = new Set(slots.filter((slot) => slot.tenant_id === tenantId).map((slot) => slot.slot));
        const free = Array.from({ length: perTenant }, (_, i) => i + 1).find((slot) => !tenantSlots.has(slot));
        if (free === undefined) return null;
        slots.push({ slot: free, tenant_id: tenantId, workspace_id: workspaceId, claimed_at: claimedAt });
        return free;
      };
      const deleteIn = (): string[] => {
        const targets = new Set(values.map(String));
        const removed = slots.filter((slot) => targets.has(slot.workspace_id)).map((slot) => slot.workspace_id);
        const remaining = slots.filter((slot) => !targets.has(slot.workspace_id));
        slots.length = 0;
        slots.push(...remaining);
        return removed;
      };
      return {
        bind(...input: unknown[]) {
          values = input;
          return this;
        },
        async all<T>() {
          if (sql.includes('LEFT JOIN workspaces')) {
            const scoped = sql.includes('WHERE s.tenant_id') ? slots.filter((slot) => slot.tenant_id === values[0]) : slots;
            const rows = [...scoped]
              .sort((a, b) => a.slot - b.slot)
              .map((slot) => ({
                slot: slot.slot,
                tenant_id: slot.tenant_id,
                workspace_id: slot.workspace_id,
                claimed_at: slot.claimed_at,
                state: workspaces[slot.workspace_id]?.state ?? null,
                updated_at: workspaces[slot.workspace_id]?.updated_at ?? null,
                has_unpushed_work: workspaces[slot.workspace_id]?.has_unpushed_work ?? null
              }));
            return { results: rows as T[] };
          }
          if (sql.startsWith('DELETE FROM workspace_slots') && sql.includes('RETURNING')) {
            return { results: deleteIn().map((workspace_id) => ({ workspace_id })) as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (sql.includes('INSERT INTO workspace_slots')) {
            const slot = claim();
            return (slot === null ? null : { slot }) as T | null;
          }
          if (sql.includes('global_count')) {
            return {
              global_count: slots.length,
              tenant_count: slots.filter((slot) => slot.tenant_id === values[0]).length
            } as T;
          }
          if (sql.includes('SELECT slot FROM workspace_slots')) {
            const found = slots.find((slot) => slot.workspace_id === values[0]);
            return (found ? { slot: found.slot } : null) as T | null;
          }
          return null;
        },
        async run() {
          if (sql.startsWith('DELETE FROM workspace_slots')) {
            const before = slots.length;
            const remaining = slots.filter((slot) => slot.workspace_id !== values[0]);
            slots.length = 0;
            slots.push(...remaining);
            return { meta: { changes: before - slots.length } };
          }
          return { meta: { changes: 0 } };
        }
      };
    }
  } as unknown as D1Database & { slots: SlotRow[] };
}

const NOW = Date.parse('2026-07-19T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe('workspace slot capacity (per-tenant)', () => {
  it('defaults caps to 8 and clamps per-tenant to the global cap', () => {
    // Per-tenant default (5) is strictly below the global cap (8) so one tenant
    // cannot claim the whole pool by default.
    expect(workspaceCaps({})).toEqual({ global: 8, perTenant: 5 });
    // Clamped to the global cap when the global cap is below the per-tenant default.
    expect(workspaceCaps({ FORGE_MAX_WORKSPACES: '2' })).toEqual({ global: 2, perTenant: 2 });
    expect(workspaceCaps({ FORGE_MAX_WORKSPACES: '10', FORGE_MAX_WORKSPACES_PER_TENANT: '3' })).toEqual({ global: 10, perTenant: 3 });
    expect(slotTtlMs({})).toBe(240 * 60_000);
    expect(slotTtlMs({ FORGE_SLOT_TTL_MINUTES: "30" })).toBe(30 * 60_000);
  });

  it('assigns each tenant its own lowest free slot', async () => {
    const db = fakeD1([], {});
    const caps = { global: 8, perTenant: 8 };
    expect(await reserveWorkspaceSlot(db, 'ten_a', 'wsp_a1', caps)).toBe(1);
    expect(await reserveWorkspaceSlot(db, 'ten_a', 'wsp_a2', caps)).toBe(2);
    // A different tenant starts again at slot 1.
    expect(await reserveWorkspaceSlot(db, 'ten_b', 'wsp_b1', caps)).toBe(1);
  });

  it('rejects a tenant over its per-tenant cap while others still have room', async () => {
    const db = fakeD1([], {});
    const caps = { global: 8, perTenant: 2 };
    await reserveWorkspaceSlot(db, 'ten_a', 'wsp_a1', caps);
    await reserveWorkspaceSlot(db, 'ten_a', 'wsp_a2', caps);
    await expect(reserveWorkspaceSlot(db, 'ten_a', 'wsp_a3', caps)).rejects.toMatchObject({
      code: 'FORGE_QUOTA_EXCEEDED',
      details: { scope: 'tenant', maximum_workspaces_per_tenant: 2 }
    });
    // Another tenant is unaffected.
    expect(await reserveWorkspaceSlot(db, 'ten_b', 'wsp_b1', caps)).toBe(1);
  });

  it('rejects with global scope when the global cap is reached across tenants', async () => {
    const db = fakeD1([], {});
    const caps = { global: 2, perTenant: 8 };
    await reserveWorkspaceSlot(db, 'ten_a', 'wsp_a1', caps);
    await reserveWorkspaceSlot(db, 'ten_b', 'wsp_b1', caps);
    await expect(reserveWorkspaceSlot(db, 'ten_c', 'wsp_c1', caps)).rejects.toMatchObject({
      code: 'FORGE_QUOTA_EXCEEDED',
      details: { scope: 'global', global_in_use: 2 }
    });
  });

  it('handles a large per-tenant range without a compound-SELECT term explosion', async () => {
    // Regression: the reserve query must scale to large N via a recursive CTE,
    // not an N-term UNION ALL chain (which D1 rejects as "too many terms").
    const db = fakeD1([], {});
    const caps = { global: 100, perTenant: 50 };
    for (let index = 1; index <= 50; index += 1) {
      expect(await reserveWorkspaceSlot(db, 'ten_a', `wsp_${index}`, caps)).toBe(index);
    }
    await expect(reserveWorkspaceSlot(db, 'ten_a', 'wsp_over', caps)).rejects.toMatchObject({
      code: 'FORGE_QUOTA_EXCEEDED',
      details: { scope: 'tenant' }
    });
  });

  it('is idempotent for a workspace that already holds a slot', async () => {
    const db = fakeD1([], {});
    const caps = { global: 8, perTenant: 8 };
    const first = await reserveWorkspaceSlot(db, 'ten_a', 'wsp_a1', caps);
    const replay = await reserveWorkspaceSlot(db, 'ten_a', 'wsp_a1', caps);
    expect(replay).toBe(first);
    expect(db.slots.length).toBe(1);
  });

  it('reclaims idle/terminal/orphaned slots across tenants but keeps active ones', async () => {
    const db = fakeD1(
      [
        { slot: 1, tenant_id: 'ten_a', workspace_id: 'wsp_busy', claimed_at: minutesAgo(120) },
        { slot: 2, tenant_id: 'ten_a', workspace_id: 'wsp_idle', claimed_at: minutesAgo(120) },
        { slot: 1, tenant_id: 'ten_b', workspace_id: 'wsp_dead', claimed_at: minutesAgo(5) }
      ],
      {
        wsp_busy: { state: 'ready', updated_at: minutesAgo(1) },
        wsp_idle: { state: "ready", updated_at: minutesAgo(300) },
        wsp_dead: { state: 'failed', updated_at: minutesAgo(5) }
      }
    );
    const reclaimed = await reclaimStaleSlots(db, slotTtlMs({}), NOW);
    expect(reclaimed.map((r) => r.workspaceId).sort()).toEqual(['wsp_dead', 'wsp_idle']);
    expect(db.slots.map((s) => s.workspace_id)).toEqual(['wsp_busy']);
    // Freed slot is immediately reusable.
    expect(await reserveWorkspaceSlot(db, 'ten_a', 'wsp_new', { global: 8, perTenant: 8 })).toBe(2);
  });

  it('reclaims a workspace wedged in provisioning past the short stuck bound but spares a fresh one', async () => {
    const db = fakeD1(
      [
        { slot: 1, tenant_id: 'ten_a', workspace_id: 'wsp_wedged', claimed_at: minutesAgo(20) },
        { slot: 2, tenant_id: 'ten_a', workspace_id: 'wsp_fresh', claimed_at: minutesAgo(2) },
        { slot: 3, tenant_id: 'ten_a', workspace_id: 'wsp_boot', claimed_at: minutesAgo(30) }
      ],
      {
        // Stuck in provisioning for 20 min → reclaimable on the 15-min stuck bound
        // even though it is far short of the 240-min idle TTL.
        wsp_wedged: { state: 'provisioning', updated_at: minutesAgo(20) },
        // Only 2 min in provisioning → still healthy, keep it.
        wsp_fresh: { state: 'provisioning', updated_at: minutesAgo(2) },
        // Wedged in bootstrapping counts too.
        wsp_boot: { state: 'bootstrapping', updated_at: minutesAgo(30) }
      }
    );
    const occupants = await listSlotOccupants(db, slotTtlMs({}), NOW);
    expect(occupants.filter((o) => o.stuckProvisioning).map((o) => o.workspaceId).sort()).toEqual(['wsp_boot', 'wsp_wedged']);
    const reclaimed = await reclaimStaleSlots(db, slotTtlMs({}), NOW);
    expect(reclaimed.map((r) => r.workspaceId).sort()).toEqual(['wsp_boot', 'wsp_wedged']);
    expect(reclaimed.every((r) => r.reason === 'stuck_provisioning')).toBe(true);
    expect(db.slots.map((s) => s.workspace_id)).toEqual(['wsp_fresh']);
  });

  it('protects an idle workspace with unpushed work from idle-reaping by default', async () => {
    const db = fakeD1(
      [{ slot: 1, tenant_id: 'ten_a', workspace_id: 'wsp_dirty', claimed_at: minutesAgo(600) }],
      { wsp_dirty: { state: 'ready', updated_at: minutesAgo(600), has_unpushed_work: 1 } }
    );
    // Default protectUnpushed=true: idle past TTL, but dirty work keeps the slot.
    expect(await reclaimStaleSlots(db, slotTtlMs({}), NOW)).toEqual([]);
    expect(db.slots.map((s) => s.workspace_id)).toEqual(['wsp_dirty']);
  });

  it('reaps an idle dirty workspace when protection is dropped (snapshots on)', async () => {
    const db = fakeD1(
      [{ slot: 1, tenant_id: 'ten_a', workspace_id: 'wsp_dirty', claimed_at: minutesAgo(600) }],
      { wsp_dirty: { state: 'ready', updated_at: minutesAgo(600), has_unpushed_work: 1 } }
    );
    // protectUnpushed=false: the caller snapshots to R2 first, so idle-reaping is safe.
    const reclaimed = await reclaimStaleSlots(db, slotTtlMs({}), NOW, false);
    expect(reclaimed.map((r) => r.workspaceId)).toEqual(['wsp_dirty']);
    expect(db.slots.length).toBe(0);
  });

  it('scopes occupant listing to a single tenant', async () => {
    const db = fakeD1(
      [
        { slot: 1, tenant_id: 'ten_a', workspace_id: 'wsp_a', claimed_at: minutesAgo(2) },
        { slot: 1, tenant_id: 'ten_b', workspace_id: 'wsp_b', claimed_at: minutesAgo(2) }
      ],
      { wsp_a: { state: 'ready', updated_at: minutesAgo(1) }, wsp_b: { state: 'ready', updated_at: minutesAgo(1) } }
    );
    const forA = await listSlotOccupants(db, slotTtlMs({}), NOW, 'ten_a');
    expect(forA.map((o) => o.workspaceId)).toEqual(['wsp_a']);
  });

  it('releases a held slot', async () => {
    const db = fakeD1([{ slot: 1, tenant_id: 'ten_a', workspace_id: 'wsp_a', claimed_at: minutesAgo(2) }], {
      wsp_a: { state: 'ready', updated_at: minutesAgo(1) }
    });
    await releaseWorkspaceSlot(db, 'wsp_a');
    expect(db.slots.length).toBe(0);
  });
});
