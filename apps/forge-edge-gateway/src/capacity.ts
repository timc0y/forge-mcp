import { ForgeError } from '@forge/core';

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
    throw new ForgeError({
      code: 'FORGE_QUOTA_EXCEEDED',
      message: 'Forge Cloud is already using both workspace slots. Finish or destroy one workspace, then retry.',
      retryable: true,
      details: { maximum_workspaces: 2 }
    });
  }
  return reservation.slot;
}

export async function releaseWorkspaceSlot(database: D1Database, workspaceId: string): Promise<void> {
  await database.prepare('DELETE FROM workspace_slots WHERE workspace_id = ?1').bind(workspaceId).run();
}
