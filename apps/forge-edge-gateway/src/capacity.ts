import { ForgeError } from '@forge/core';

// Forge workspace slots are per-tenant: each tenant holds up to `perTenant`
// concurrent workspaces (its own 1..N slot range), while a global cap bounds the
// total across all tenants — and thus container cost — so one busy account
// cannot starve the rest. A slot is a D1 row, claimed on workspace_create and
// deleted on destroy or a create failure. The container's 90s idle sleep only
// stops compute, never frees the slot, so the lazy + scheduled reaper reclaims
// slots whose workspace is gone, terminal, or idle past a TTL.

const DEFAULT_SLOT_TTL_MINUTES = 30;
const DEFAULT_GLOBAL_CAP = 8;
const DEFAULT_PER_TENANT_CAP = 8;
const TERMINAL_STATES = ['suspended', 'failed', 'destroying', 'destroyed'];

export interface WorkspaceCaps {
  global: number;
  perTenant: number;
}

export interface SlotOccupant {
  slot: number;
  tenantId: string;
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
  tenantId: string;
  workspaceId: string;
  claimedAt: string;
  reason: 'orphaned' | 'terminal_state' | 'idle_ttl_exceeded';
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function slotTtlMs(env: { FORGE_SLOT_TTL_MINUTES?: string }): number {
  return positiveInt(env.FORGE_SLOT_TTL_MINUTES, DEFAULT_SLOT_TTL_MINUTES) * 60_000;
}

export function workspaceCaps(env: {
  FORGE_MAX_WORKSPACES?: string;
  FORGE_MAX_WORKSPACES_PER_TENANT?: string;
}): WorkspaceCaps {
  const global = positiveInt(env.FORGE_MAX_WORKSPACES, DEFAULT_GLOBAL_CAP);
  // A tenant can never exceed the global cap however it is configured.
  const perTenant = Math.min(global, positiveInt(env.FORGE_MAX_WORKSPACES_PER_TENANT, DEFAULT_PER_TENANT_CAP));
  return { global, perTenant };
}

function ageMinutes(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((now - parsed) / 60_000));
}

// Join every claimed slot to its workspace so callers (the quota error, the
// dashboard, the reaper) can see what is holding capacity and why. Pass
// `tenantId` to scope to one tenant (dashboard); omit for the global view.
export async function listSlotOccupants(
  database: D1Database,
  ttlMs: number,
  now: number = Date.now(),
  tenantId?: string
): Promise<SlotOccupant[]> {
  const rows = await database.prepare(
    `SELECT s.slot AS slot, s.tenant_id AS tenant_id, s.workspace_id AS workspace_id, s.claimed_at AS claimed_at,
            w.state AS state, w.updated_at AS updated_at
       FROM workspace_slots AS s
       LEFT JOIN workspaces AS w ON w.id = s.workspace_id
       ${tenantId ? 'WHERE s.tenant_id = ?1' : ''}
       ORDER BY s.tenant_id, s.slot`
  ).bind(...(tenantId ? [tenantId] : [])).all<{
    slot: number; tenant_id: string; workspace_id: string; claimed_at: string; state: string | null; updated_at: string | null;
  }>();
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
      tenantId: row.tenant_id,
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
// lazily on the contended create path and on a cron schedule. The workspace
// teardown is left to the caller, which owns the workflow binding.
export async function reclaimStaleSlots(
  database: D1Database,
  ttlMs: number,
  now: number = Date.now()
): Promise<ReclaimedSlot[]> {
  const occupants = await listSlotOccupants(database, ttlMs, now);
  const stale = occupants.filter((occupant) => occupant.stale);
  if (stale.length === 0) return [];
  // One batched DELETE instead of a round trip per row. RETURNING confirms
  // exactly which rows this call removed, so concurrent reapers do not double-count.
  const placeholders = stale.map((_, index) => `?${index + 1}`).join(', ');
  const deleted = await database.prepare(
    `DELETE FROM workspace_slots WHERE workspace_id IN (${placeholders}) RETURNING workspace_id`
  ).bind(...stale.map((occupant) => occupant.workspaceId)).all<{ workspace_id: string }>();
  const removed = new Set((deleted.results ?? []).map((row) => row.workspace_id));
  const reclaimed: ReclaimedSlot[] = [];
  for (const occupant of stale) {
    if (!removed.has(occupant.workspaceId)) continue;
    const reason: ReclaimedSlot['reason'] =
      occupant.state === null
        ? 'orphaned'
        : TERMINAL_STATES.includes(occupant.state)
          ? 'terminal_state'
          : 'idle_ttl_exceeded';
    reclaimed.push({ slot: occupant.slot, tenantId: occupant.tenantId, workspaceId: occupant.workspaceId, claimedAt: occupant.claimedAt, reason });
    console.log('forge_slot_reclaimed', {
      slot: occupant.slot,
      tenantId: occupant.tenantId,
      workspaceId: occupant.workspaceId,
      reason,
      idleMinutes: occupant.idleMinutes,
      state: occupant.state
    });
  }
  return reclaimed;
}

async function slotCounts(database: D1Database, tenantId: string): Promise<{ global: number; tenant: number }> {
  const row = await database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM workspace_slots) AS global_count,
       (SELECT COUNT(*) FROM workspace_slots WHERE tenant_id = ?1) AS tenant_count`
  ).bind(tenantId).first<{ global_count: number; tenant_count: number }>();
  return { global: row?.global_count ?? 0, tenant: row?.tenant_count ?? 0 };
}

export async function reserveWorkspaceSlot(
  database: D1Database,
  tenantId: string,
  workspaceId: string,
  caps: WorkspaceCaps
): Promise<number> {
  // Atomic claim in a single statement: pick the lowest free slot in the
  // tenant's 1..perTenant range (NOT EXISTS bounds the per-tenant cap) while the
  // global count is under the global cap. RETURNING yields the slot on success.
  const candidates = Array.from({ length: caps.perTenant }, (_, index) => `SELECT ${index + 1} AS slot`).join(' UNION ALL ');
  const inserted = await database.prepare(
    `INSERT INTO workspace_slots (workspace_id, tenant_id, slot, claimed_at)
       SELECT ?1, ?2, candidate.slot, ?3
         FROM (${candidates}) AS candidate
        WHERE NOT EXISTS (SELECT 1 FROM workspace_slots s WHERE s.tenant_id = ?2 AND s.slot = candidate.slot)
          AND (SELECT COUNT(*) FROM workspace_slots) < ?4
        ORDER BY candidate.slot
        LIMIT 1
       ON CONFLICT(workspace_id) DO NOTHING
       RETURNING slot`
  ).bind(workspaceId, tenantId, new Date().toISOString(), caps.global).first<{ slot: number }>();
  if (inserted) {
    console.log('forge_slot_reserved', { slot: inserted.slot, tenantId, workspaceId });
    return inserted.slot;
  }
  // Null insert: either this workspace already holds a slot (idempotent replay)
  // or a cap was hit. Disambiguate.
  const existing = await database.prepare(
    'SELECT slot FROM workspace_slots WHERE workspace_id = ?1'
  ).bind(workspaceId).first<{ slot: number }>();
  if (existing) {
    console.log('forge_slot_reserved', { slot: existing.slot, tenantId, workspaceId, replay: true });
    return existing.slot;
  }
  const counts = await slotCounts(database, tenantId);
  const scope = counts.tenant >= caps.perTenant ? 'tenant' : 'global';
  console.warn('forge_slot_quota_exceeded', { tenantId, workspaceId, scope, counts, caps });
  throw new ForgeError({
    code: 'FORGE_QUOTA_EXCEEDED',
    message:
      scope === 'tenant'
        ? `This account is already running its maximum of ${caps.perTenant} workspaces. Finish or destroy one, then retry.`
        : `Forge is at global capacity (${caps.global} workspaces). Retry shortly, or destroy an idle workspace.`,
    retryable: true,
    details: {
      scope,
      maximum_workspaces: caps.global,
      maximum_workspaces_per_tenant: caps.perTenant,
      global_in_use: counts.global,
      tenant_in_use: counts.tenant
    }
  });
}

export async function releaseWorkspaceSlot(database: D1Database, workspaceId: string): Promise<void> {
  const result = await database.prepare('DELETE FROM workspace_slots WHERE workspace_id = ?1').bind(workspaceId).run();
  if ((result.meta.changes ?? 0) > 0) {
    console.log('forge_slot_released', { workspaceId });
  }
}
