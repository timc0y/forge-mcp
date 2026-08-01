import { ForgeError } from '@forge/core';

// Forge workspace slots are per-tenant: each tenant holds up to `perTenant`
// concurrent workspaces (its own 1..N slot range), while a global cap bounds the
// total across all tenants — and thus container cost — so one busy account
// cannot starve the rest. A slot is a D1 row, claimed on workspace_create and
// deleted on destroy or a create failure. The container's idle sleep only
// stops compute, never frees the slot, so the lazy + scheduled reaper reclaims
// slots whose workspace is gone, terminal, or idle past a TTL.

// Idle workspaces are reclaimed after this long. Generous by default so an
// in-progress harness (installed deps, built artifacts, a running dev server)
// is not torn down between bursts of activity. Cost-neutral: the container
// already sleeps on idle (and keepAlive covers active mutations), so a
// held-but-idle slot bills ~nothing — this only governs when the workspace is
// destroyed and its slot freed.
const DEFAULT_SLOT_TTL_MINUTES = 240;
const DEFAULT_GLOBAL_CAP = 8;
// Keep the per-tenant default strictly below the global cap so the fairness
// promise above actually holds by default: a single busy tenant can claim five
// of the eight global slots, leaving room for others. Raise it per
// deployment via FORGE_MAX_WORKSPACES_PER_TENANT; it is always clamped to the
// global cap in workspaceCaps().
const DEFAULT_PER_TENANT_CAP = 5;
// Exported so workspace-resolve.ts can exclude the same states when deciding
// which workspaces are "live" candidates for owner/repo/branch resolution —
// one definition of "terminal", not two that can drift apart.
export const TERMINAL_STATES = ['failed', 'destroying', 'destroyed'];
// States where a provision Workflow is actively running. Sitting in one longer
// than STUCK_PROVISION_MS means the workflow died mid-run (timed out / evicted
// before its JS catch) and the slot is leaking. Reclaimable on the short bound
// below instead of the generous idle TTL; the scheduled watchdog force-fails it.
//
// `requested` is intentionally excluded: lazy create parks there with a GitHub
// branch and no executor until the first execution tool. That can last far
// longer than STUCK_PROVISION_MS and must use the normal idle TTL, not the
// wedged-provisioner reaper.
const ACTIVE_PROVISIONING_STATES = ['provisioning', 'bootstrapping'];
const STUCK_PROVISION_MS = 15 * 60_000;

interface WorkspaceCaps {
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
  // True when the workspace is wedged in a non-terminal provisioning state past
  // STUCK_PROVISION_MS. The watchdog reaps these via markProvisioningExhausted
  // (force `failed`) rather than the normal destroy-workflow teardown.
  stuckProvisioning: boolean;
  // Which repository and branch this occupant's workspace is on, so
  // workspace-resolve.ts can answer "which workspace did the caller mean"
  // without the caller ever naming the workspace id. Null when the joined
  // workspace row is missing, or its `repository` column does not parse as
  // `owner/name` (defensive: one malformed row must not break resolution for
  // every other occupant in the list).
  repository: { owner: string; name: string } | null;
  currentBranch: string | null;
}

// `workspaces.repository` is stored as a plain "owner/name" string (see
// packages/metadata-d1/src/index.ts), not JSON — parsed the same way
// D1MetadataStore.getWorkspace does, but tolerant of a row that does not
// match the shape instead of throwing, since this feeds ambiguity resolution
// for every OTHER live workspace too.
function parseRepositoryColumn(raw: string | null): { owner: string; name: string } | null {
  if (!raw) return null;
  const separator = raw.indexOf('/');
  if (separator <= 0 || separator === raw.length - 1) return null;
  const owner = raw.slice(0, separator);
  const name = raw.slice(separator + 1);
  return owner && name ? { owner, name } : null;
}

interface ReclaimedSlot {
  slot: number;
  tenantId: string;
  workspaceId: string;
  claimedAt: string;
  reason: 'orphaned' | 'terminal_state' | 'idle_ttl_exceeded' | 'stuck_provisioning';
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
            w.state AS state, w.updated_at AS updated_at,
            w.repository AS repository, w.current_branch AS current_branch
       FROM workspace_slots AS s
       LEFT JOIN workspaces AS w ON w.id = s.workspace_id
       ${tenantId ? 'WHERE s.tenant_id = ?1' : ''}
       ORDER BY s.tenant_id, s.slot`
  ).bind(...(tenantId ? [tenantId] : [])).all<{
    slot: number; tenant_id: string; workspace_id: string; claimed_at: string; state: string | null; updated_at: string | null;
    repository: string | null; current_branch: string | null;
  }>();
  const ttlMinutes = ttlMs / 60_000;
  return (rows.results ?? []).map((row) => {
    const lastActive = row.updated_at ?? row.claimed_at;
    const idle = ageMinutes(lastActive, now);
    const terminal = row.state === null || (row.state !== null && TERMINAL_STATES.includes(row.state));
    const idleExpired = idle !== null && idle >= ttlMinutes;
    // A workspace wedged in a provisioning state (the workflow died before it
    // could fail cleanly) leaks its slot; reclaim it on the short STUCK bound
    // instead of the 240-min idle TTL so capacity recovers in minutes. `ready`
    // and other live states keep the generous idle TTL below.
    const stuckProvisioning =
      row.state !== null &&
      ACTIVE_PROVISIONING_STATES.includes(row.state) &&
      idle !== null &&
      idle >= STUCK_PROVISION_MS / 60_000;
    const stale = terminal || stuckProvisioning || idleExpired;
    return {
      slot: row.slot,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      claimedAt: row.claimed_at,
      state: row.state,
      lastActiveAt: row.updated_at,
      ageMinutes: ageMinutes(row.claimed_at, now) ?? 0,
      idleMinutes: idle,
      stale,
      stuckProvisioning,
      repository: parseRepositoryColumn(row.repository),
      currentBranch: row.current_branch
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
          : occupant.stuckProvisioning
            ? 'stuck_provisioning'
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
  // The candidate range is built with a recursive CTE rather than a UNION ALL
  // chain — D1 caps the number of terms in a compound SELECT, so an N-term chain
  // fails ("too many terms in compound SELECT") whereas the two-arm recursive
  // CTE is unbounded in N.
  const inserted = await database.prepare(
    `WITH RECURSIVE candidate(slot) AS (
        SELECT 1
        UNION ALL
        SELECT slot + 1 FROM candidate WHERE slot < ?1
      )
      INSERT INTO workspace_slots (workspace_id, tenant_id, slot, claimed_at)
        SELECT ?2, ?3, candidate.slot, ?4
          FROM candidate
         WHERE NOT EXISTS (SELECT 1 FROM workspace_slots s WHERE s.tenant_id = ?3 AND s.slot = candidate.slot)
           AND (SELECT COUNT(*) FROM workspace_slots) < ?5
         ORDER BY candidate.slot
         LIMIT 1
        ON CONFLICT(workspace_id) DO NOTHING
        RETURNING slot`
  ).bind(caps.perTenant, workspaceId, tenantId, new Date().toISOString(), caps.global).first<{ slot: number }>();
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
  // "Finish or destroy one, then retry" named no tool and listed nothing, so
  // there was no way to act on it: an agent that cannot see which workspaces
  // are open cannot choose one to destroy. It retried fifteen times in two
  // minutes instead, destroying nothing. The occupants are already in hand —
  // name them, and name the tool that closes one.
  // The TTL argument only drives the staleness flags, which this call ignores —
  // it wants the repository and branch names, nothing else — so the default is
  // fine here rather than threading env through reserveWorkspaceSlot.
  const occupants = await listSlotOccupants(
    database,
    DEFAULT_SLOT_TTL_MINUTES * 60_000,
    Date.now(),
    tenantId
  ).catch(() => [] as SlotOccupant[]);
  const named = occupants
    .map((occupant) =>
      occupant.repository && occupant.currentBranch
        ? `${occupant.repository.owner}/${occupant.repository.name} on ${occupant.currentBranch}`
        : occupant.repository
          ? `${occupant.repository.owner}/${occupant.repository.name}`
          : undefined
    )
    .filter((entry): entry is string => Boolean(entry));
  const openList = named.length ? ` Open now: ${named.join('; ')}.` : '';
  throw new ForgeError({
    code: 'FORGE_QUOTA_EXCEEDED',
    message:
      scope === 'tenant'
        ? `This account is already running its maximum of ${caps.perTenant} workspaces, so a new one cannot start until one closes.${openList} Call forge_workspace_destroy on the one you have finished with, then create again — retrying this call unchanged will keep failing, because nothing about it is transient.`
        : `Forge is at global capacity (${caps.global} workspaces), which is a shared limit rather than anything about this account.${openList} Wait a minute and retry, or call forge_workspace_destroy on a workspace you have finished with.`,
    retryable: true,
    details: {
      scope,
      maximum_workspaces: caps.global,
      maximum_workspaces_per_tenant: caps.perTenant,
      global_in_use: counts.global,
      tenant_in_use: counts.tenant,
      ...(named.length ? { open_workspaces: named } : {})
    }
  });
}

export async function releaseWorkspaceSlot(database: D1Database, workspaceId: string): Promise<void> {
  const result = await database.prepare('DELETE FROM workspace_slots WHERE workspace_id = ?1').bind(workspaceId).run();
  if ((result.meta.changes ?? 0) > 0) {
    console.log('forge_slot_released', { workspaceId });
  }
}
