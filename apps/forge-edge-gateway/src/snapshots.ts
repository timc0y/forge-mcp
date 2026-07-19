import type { Env } from './env';

// snapshot_on_idle: persist a workspace's /workspace directory to R2 as a
// gzipped tar before the reaper destroys it, and restore it on next use so an
// agent's harness (installed deps, built artifacts, uncommitted work) survives
// reaping instead of being rebuilt from scratch.
//
// The tar/untar runs INSIDE the workspace container (which has real tar/curl);
// the Worker is just the authenticated R2 gateway at /__forge_snapshot/<id>.
// Everything here is gated on FORGE_SNAPSHOT_ENABLED — off means the whole
// feature is inert and provision/destroy behave exactly as before.

export function snapshotsEnabled(env: Pick<Env, 'FORGE_SNAPSHOT_ENABLED'>): boolean {
  return env.FORGE_SNAPSHOT_ENABLED === 'true' || env.FORGE_SNAPSHOT_ENABLED === '1';
}

export function snapshotKey(tenantId: string, workspaceId: string): string {
  return `snapshots/${tenantId}/${workspaceId}.tar.gz`;
}

export interface SnapshotIndexRow {
  workspace_id: string;
  tenant_id: string;
  r2_key: string;
  size_bytes: number | null;
  created_at: string;
}

export async function recordSnapshot(
  db: D1Database,
  input: { workspaceId: string; tenantId: string; r2Key: string; sizeBytes: number; createdAt: string }
): Promise<void> {
  await db.prepare(
    `INSERT INTO workspace_snapshots (workspace_id, tenant_id, r2_key, size_bytes, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(workspace_id) DO UPDATE SET r2_key = excluded.r2_key, size_bytes = excluded.size_bytes, created_at = excluded.created_at`
  ).bind(input.workspaceId, input.tenantId, input.r2Key, input.sizeBytes, input.createdAt).run();
}

export async function getSnapshot(db: D1Database, workspaceId: string): Promise<SnapshotIndexRow | null> {
  return db.prepare('SELECT workspace_id, tenant_id, r2_key, size_bytes, created_at FROM workspace_snapshots WHERE workspace_id = ?1')
    .bind(workspaceId).first<SnapshotIndexRow>();
}
