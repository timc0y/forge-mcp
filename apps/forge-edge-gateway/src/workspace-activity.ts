import type { Env } from './env';

export interface WorkspaceActivityRow {
  id: string;
  tenantId: string;
  projectId: string | null;
  workspaceId: string | null;
  tool: string;
  status: 'success' | 'error';
  durationMs: number;
  errorCode: string | null;
  occurredAt: string;
}

const RETENTION_DAYS = 14;

export async function appendWorkspaceActivity(
  env: Env,
  input: {
    tenantId: string;
    projectId?: string;
    workspaceId?: string | null;
    tool: string;
    status: 'success' | 'error';
    durationMs: number;
    errorCode?: string;
    occurredAt?: string;
  }
): Promise<void> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const id = crypto.randomUUID();
  await env.METADATA.prepare(
    `INSERT INTO workspace_activity (id, tenant_id, project_id, workspace_id, tool, status, duration_ms, error_code, occurred_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(
    id,
    input.tenantId,
    input.projectId ?? null,
    input.workspaceId ?? null,
    input.tool,
    input.status,
    input.durationMs,
    input.errorCode ?? null,
    occurredAt
  ).run();
  // Best-effort prune so the table does not grow without bound.
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  await env.METADATA.prepare(
    'DELETE FROM workspace_activity WHERE tenant_id = ?1 AND occurred_at < ?2'
  ).bind(input.tenantId, cutoff).run().catch(() => undefined);
}

export async function listWorkspaceActivity(
  env: Env,
  tenantId: string,
  input: { workspaceId?: string; limit?: number; since?: string } = {}
): Promise<WorkspaceActivityRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 200);
  const since = input.since;
  if (input.workspaceId) {
    const rows = since
      ? await env.METADATA.prepare(
          `SELECT id, tenant_id, project_id, workspace_id, tool, status, duration_ms, error_code, occurred_at
             FROM workspace_activity
            WHERE tenant_id = ?1 AND workspace_id = ?2 AND occurred_at >= ?3
            ORDER BY occurred_at DESC LIMIT ?4`
        ).bind(tenantId, input.workspaceId, since, limit).all<Row>()
      : await env.METADATA.prepare(
          `SELECT id, tenant_id, project_id, workspace_id, tool, status, duration_ms, error_code, occurred_at
             FROM workspace_activity
            WHERE tenant_id = ?1 AND workspace_id = ?2
            ORDER BY occurred_at DESC LIMIT ?3`
        ).bind(tenantId, input.workspaceId, limit).all<Row>();
    return mapRows(rows.results ?? []);
  }
  const rows = since
    ? await env.METADATA.prepare(
        `SELECT id, tenant_id, project_id, workspace_id, tool, status, duration_ms, error_code, occurred_at
           FROM workspace_activity
          WHERE tenant_id = ?1 AND occurred_at >= ?2
          ORDER BY occurred_at DESC LIMIT ?3`
      ).bind(tenantId, since, limit).all<Row>()
    : await env.METADATA.prepare(
        `SELECT id, tenant_id, project_id, workspace_id, tool, status, duration_ms, error_code, occurred_at
           FROM workspace_activity
          WHERE tenant_id = ?1
          ORDER BY occurred_at DESC LIMIT ?2`
      ).bind(tenantId, limit).all<Row>();
  return mapRows(rows.results ?? []);
}

type Row = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  workspace_id: string | null;
  tool: string;
  status: string;
  duration_ms: number;
  error_code: string | null;
  occurred_at: string;
};

function mapRows(rows: Row[]): WorkspaceActivityRow[] {
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    tool: row.tool,
    status: row.status === 'error' ? 'error' : 'success',
    durationMs: row.duration_ms,
    errorCode: row.error_code,
    occurredAt: row.occurred_at
  }));
}
