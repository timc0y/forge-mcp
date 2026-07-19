import { ForgeError } from '@forge/core';

// Forge Cloud shares two global workspace slots. A slot is a D1 row, claimed on
// workspace_create and deleted on destroy or a create failure. Crucially, the
// container's 90s idle sleep only stops compute — it never frees the slot. So a
// workspace whose owner walked away (agent crashed, session ended, destroy
// never called) would hold a slot forever, and two such orphans would make
// Forge permanently report "no slots". The lazy reaper below reclaims slots
// whose workspace is gone, terminal, or idle past a TTL, so capacity recovers
// on its own instead of needing a manual destroy.

const DEFAULT_SLOT_TTL_MINUTES = 30;
const TERMINAL_STATES = ['suspended', 'failed', 'destroying', 'destroyed'];

export interface SlotOccupant {
  slot: number;
  workspaceId: string;
  claimedAt: string;
  state: string | null;
  lastActiveAt: string | null;
  ageMinutes: number;
  idleMinutes: number | null;
  stale: boolean;
}

export interface ReclaimedSlot {
  slot: number;
  workspaceId: string;
  claimedAt: string;
  reason: 'orphaned' | 'terminal_state' | 'idle_ttl_exceeded';
}

export function slotTtlMs(env: { FORGE_SLOT_TTL_MINUTES?: string }): number {
  const parsed = Number(env.FORGE_SLOT_TTL_MINUTES);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SLOT_TTL_MINUTES;
  return minutes * 60_000;
}

function ageMinutes(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((now - parsed) / 60_000));
}

// Join every claimed slot to its workspace so callers (the quota error and the
// dashboard) can see exactly what is holding capacity and why.
export async function listSlotOccupants(
  database: D1Database,
  ttlMs: number,
  now: number = Date.now()
): Promise<SlotOccupant[]> {
  const rows = await database.prepare(
    `SELECT s.slot AS slot, s.workspace_id AS workspace_id, s.claimed_at AS claimed_at,
            w.state AS state, w.updated_at AS updated_at
       FROM workspace_slots AS s
       LEFT JOIN workspaces AS w ON w.id = s.workspace_id
       ORDER BY s.slot`
  ).all<{ slot: number; workspace_id: string; claimed_at: string; state: string | null; updated_at: string | null }>();
  const ttlMinutes = ttlMs / 60_000;
  return (rows.results ?? []).map((row) => {
    const lastActive = row.updated_at ?? row.claimed_at;
    const idle = ageMinutes(lastActive, now);
    const stale =
      row.state === null ||
      (row.state !== null && TERMINAL_STATES.includes(row.state)) ||
      (idle !== null && idle >= ttlMinutes);
    return {
      slot: row.slot,
      workspaceId: row.workspace_id,
      claimedAt: row.claimed_at,
      state: row.state,
      lastActiveAt: row.updated_at,
      ageMinutes: ageMinutes(row.claimed_at, now) ?? 0,
      idleMinutes: idle,
      stale
    };
  });
}

// Free slots whose workspace is missing, terminal, or idle past the TTL. Runs
// lazily on the next reservation attempt, so no cron trigger is required. The
// underlying workspace teardown is left to the caller, which owns the workflow
// binding; freeing the slot here is what immediately restores capacity.
export async function reclaimStaleSlots(
  database: D1Database,
  ttlMs: number,
  now: number = Date.now()
): Promise<ReclaimedSlot[]> {
  const occupants = await listSlotOccupants(database, ttlMs, now);
  const stale = occupants.filter((occupant) => occupant.stale);
  if (stale.length === 0) return [];
  const reclaimed: ReclaimedSlot[] = [];
  for (const occupant of stale) {
    const result = await database.prepare(
      'DELETE FROM workspace_slots WHERE workspace_id = ?1'
    ).bind(occupant.workspaceId).run();
    if ((result.meta.changes ?? 0) > 0) {
      const reason: ReclaimedSlot['reason'] =
        occupant.state === null
          ? 'orphaned'
          : TERMINAL_STATES.includes(occupant.state)
            ? 'terminal_state'
            : 'idle_ttl_exceeded';
      reclaimed.push({
        slot: occupant.slot,
        workspaceId: occupant.workspaceId,
        claimedAt: occupant.claimedAt,
        reason
      });
      console.log('forge_slot_reclaimed', {
        slot: occupant.slot,
        workspaceId: occupant.workspaceId,
        reason,
        idleMinutes: occupant.idleMinutes,
        state: occupant.state
      });
    }
  }
  return reclaimed;
}

export async function reserveWorkspaceSlot(database: D1Database, workspaceId: string): Promise<number> {
  await database.prepare(
    `INSERT INTO workspace_slots (slot, workspace_id, claimed_at)
       SELECT candidate.slot, ?1, ?2
         FROM (SELECT 1 AS slot UNION ALL SELECT 2 AS slot) AS candidate
        WHERE NOT EXISTS (SELECT 1 FROM workspace_slots AS claimed WHERE claimed.slot = candidate.slot)
        ORDER BY candidate.slot
        LIMIT 1
       ON CONFLICT(workspace_id) DO NOTHING`
  ).bind(workspaceId, new Date().toISOString()).run();
  const reservation = await database.prepare(
    'SELECT slot FROM workspace_slots WHERE workspace_id = ?1'
  ).bind(workspaceId).first<{ slot: number }>();
  if (!reservation) {
    // Surface who is holding the two slots so the caller (and its logs) can see
    // why capacity is exhausted instead of only "no slots".
    const occupants = await listSlotOccupants(database, slotTtlMs({}), Date.now()).catch(() => []);
    console.warn('forge_slot_quota_exceeded', {
      workspaceId,
      occupants: occupants.map((occupant) => ({
        slot: occupant.slot,
        workspaceId: occupant.workspaceId,
        state: occupant.state,
        idleMinutes: occupant.idleMinutes,
        stale: occupant.stale
      }))
    });
    throw new ForgeError({
      code: 'FORGE_QUOTA_EXCEEDED',
      message: 'Forge Cloud is already using both workspace slots. Finish or destroy one workspace, then retry.',
      retryable: true,
      details: {
        maximum_workspaces: 2,
        occupants: occupants.map((occupant) => ({
          slot: occupant.slot,
          workspace_id: occupant.workspaceId,
          state: occupant.state,
          idle_minutes: occupant.idleMinutes,
          stale: occupant.stale
        }))
      }
    });
  }
  console.log('forge_slot_reserved', { slot: reservation.slot, workspaceId });
  return reservation.slot;
}

export async function releaseWorkspaceSlot(database: D1Database, workspaceId: string): Promise<void> {
  const result = await database.prepare('DELETE FROM workspace_slots WHERE workspace_id = ?1').bind(workspaceId).run();
  if ((result.meta.changes ?? 0) > 0) {
    console.log('forge_slot_released', { workspaceId });
  }
}
