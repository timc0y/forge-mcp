import { describe, expect, it } from 'vitest';
import {
  listSlotOccupants,
  reclaimStaleSlots,
  releaseWorkspaceSlot,
  reserveWorkspaceSlot,
  slotTtlMs
} from '../../apps/forge-edge-gateway/src/capacity';

interface SlotRow {
  slot: number;
  workspace_id: string;
  claimed_at: string;
}
interface WorkspaceRow {
  state: string;
  updated_at: string;
}

// Minimal in-memory D1 that understands only the statements capacity.ts issues.
function fakeD1(slots: SlotRow[], workspaces: Record<string, WorkspaceRow>) {
  return {
    slots,
    prepare(sql: string) {
      let values: unknown[] = [];
      // Claim the lowest free slot, mirroring the real INSERT … SELECT … LIMIT 1.
      const claim = (): number | null => {
        const used = new Set(slots.map((slot) => slot.slot));
        const free = [1, 2].find((slot) => !used.has(slot));
        if (free === undefined || slots.some((slot) => slot.workspace_id === values[0])) return null;
        slots.push({ slot: free, workspace_id: String(values[0]), claimed_at: String(values[1]) });
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
            const rows = [...slots]
              .sort((a, b) => a.slot - b.slot)
              .map((slot) => {
                const workspace = workspaces[slot.workspace_id];
                return {
                  slot: slot.slot,
                  workspace_id: slot.workspace_id,
                  claimed_at: slot.claimed_at,
                  state: workspace?.state ?? null,
                  updated_at: workspace?.updated_at ?? null
                };
              });
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

describe('workspace slot capacity', () => {
  it('defaults the TTL to 30 minutes and honours a valid override', () => {
    expect(slotTtlMs({})).toBe(30 * 60_000);
    expect(slotTtlMs({ FORGE_SLOT_TTL_MINUTES: '10' })).toBe(10 * 60_000);
    expect(slotTtlMs({ FORGE_SLOT_TTL_MINUTES: 'nonsense' })).toBe(30 * 60_000);
  });

  it('marks idle, terminal, and orphaned slots as reclaimable', async () => {
    const db = fakeD1(
      [
        { slot: 1, workspace_id: 'wsp_active', claimed_at: minutesAgo(5) },
        { slot: 2, workspace_id: 'wsp_orphan', claimed_at: minutesAgo(90) }
      ],
      { wsp_active: { state: 'ready', updated_at: minutesAgo(2) } }
    );
    const occupants = await listSlotOccupants(db, slotTtlMs({}), NOW);
    const active = occupants.find((o) => o.workspaceId === 'wsp_active');
    const orphan = occupants.find((o) => o.workspaceId === 'wsp_orphan');
    expect(active?.stale).toBe(false);
    expect(orphan?.stale).toBe(true);
    expect(orphan?.state).toBeNull();
  });

  it('reclaims an idle-past-TTL slot but keeps a recently active one', async () => {
    const db = fakeD1(
      [
        { slot: 1, workspace_id: 'wsp_busy', claimed_at: minutesAgo(120) },
        { slot: 2, workspace_id: 'wsp_idle', claimed_at: minutesAgo(120) }
      ],
      {
        wsp_busy: { state: 'ready', updated_at: minutesAgo(1) },
        wsp_idle: { state: 'ready', updated_at: minutesAgo(45) }
      }
    );
    const reclaimed = await reclaimStaleSlots(db, slotTtlMs({}), NOW);
    expect(reclaimed.map((r) => r.workspaceId)).toEqual(['wsp_idle']);
    expect(reclaimed[0]?.reason).toBe('idle_ttl_exceeded');
    expect(db.slots.map((s) => s.workspace_id)).toEqual(['wsp_busy']);
  });

  it('frees a slot after reclamation so a new workspace can reserve it', async () => {
    const db = fakeD1(
      [
        { slot: 1, workspace_id: 'wsp_live', claimed_at: minutesAgo(3) },
        { slot: 2, workspace_id: 'wsp_dead', claimed_at: minutesAgo(200) }
      ],
      {
        wsp_live: { state: 'ready', updated_at: minutesAgo(3) },
        wsp_dead: { state: 'failed', updated_at: minutesAgo(200) }
      }
    );
    const reclaimed = await reclaimStaleSlots(db, slotTtlMs({}), NOW);
    expect(reclaimed[0]?.reason).toBe('terminal_state');
    const slot = await reserveWorkspaceSlot(db, 'wsp_new');
    expect(slot).toBe(2);
  });

  it('rejects with occupant detail when both slots are genuinely busy', async () => {
    const db = fakeD1(
      [
        { slot: 1, workspace_id: 'wsp_a', claimed_at: minutesAgo(2) },
        { slot: 2, workspace_id: 'wsp_b', claimed_at: minutesAgo(4) }
      ],
      {
        wsp_a: { state: 'ready', updated_at: minutesAgo(1) },
        wsp_b: { state: 'ready', updated_at: minutesAgo(2) }
      }
    );
    await expect(reserveWorkspaceSlot(db, 'wsp_c')).rejects.toMatchObject({
      code: 'FORGE_QUOTA_EXCEEDED',
      details: { maximum_workspaces: 2 }
    });
  });

  it('releases a held slot', async () => {
    const db = fakeD1([{ slot: 1, workspace_id: 'wsp_a', claimed_at: minutesAgo(2) }], {
      wsp_a: { state: 'ready', updated_at: minutesAgo(1) }
    });
    await releaseWorkspaceSlot(db, 'wsp_a');
    expect(db.slots.length).toBe(0);
  });
});
