import type { Env } from './env';

/**
 * A bounded, human-authorized envelope letting forge_git_push auto-satisfy a
 * run of small commits within one task, without becoming a blanket
 * auto-approve. See migrations/d1/0013_push_envelopes.sql for the invariant
 * this exists to enforce: fast-forward only, fixed branch/base, every changed
 * path within allowed_paths. Never covers pull_request.create.
 */
export interface PushEnvelope {
  id: string;
  tenantId: string;
  workspaceId: string;
  taskId: string | null;
  branch: string;
  base: string;
  allowedPaths: string[];
  lastApprovedCommit: string | null;
  expiresAt: string;
}

export async function createPushEnvelope(
  env: Env,
  input: {
    tenantId: string;
    workspaceId: string;
    taskId?: string;
    branch: string;
    base: string;
    allowedPaths: string[];
    startCommit: string | null;
    ttlMinutes: number;
  }
): Promise<PushEnvelope> {
  const id = `pshenv_${crypto.randomUUID().replaceAll('-', '')}`;
  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000).toISOString();
  await env.METADATA.prepare(
    `INSERT INTO push_envelopes
      (id, tenant_id, workspace_id, task_id, branch, base, allowed_paths, last_approved_commit, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(
    id,
    input.tenantId,
    input.workspaceId,
    input.taskId ?? null,
    input.branch,
    input.base,
    JSON.stringify(input.allowedPaths),
    input.startCommit,
    new Date().toISOString(),
    expiresAt
  ).run();
  return {
    id,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    taskId: input.taskId ?? null,
    branch: input.branch,
    base: input.base,
    allowedPaths: input.allowedPaths,
    lastApprovedCommit: input.startCommit,
    expiresAt
  };
}

export async function findActiveEnvelope(
  env: Env,
  tenantId: string,
  workspaceId: string,
  branch: string,
  base: string
): Promise<PushEnvelope | null> {
  const row = await env.METADATA.prepare(
    `SELECT id, task_id, allowed_paths, last_approved_commit, expires_at FROM push_envelopes
      WHERE tenant_id=?1 AND workspace_id=?2 AND branch=?3 AND base=?4
        AND revoked_at IS NULL AND expires_at > ?5
      ORDER BY created_at DESC LIMIT 1`
  ).bind(tenantId, workspaceId, branch, base, new Date().toISOString())
    .first<{ id: string; task_id: string | null; allowed_paths: string; last_approved_commit: string | null; expires_at: string }>();
  if (!row) return null;
  return {
    id: row.id,
    tenantId,
    workspaceId,
    taskId: row.task_id,
    branch,
    base,
    allowedPaths: JSON.parse(row.allowed_paths) as string[],
    lastApprovedCommit: row.last_approved_commit,
    expiresAt: row.expires_at
  };
}

export async function recordEnvelopePush(env: Env, envelopeId: string, newCommit: string): Promise<void> {
  await env.METADATA.prepare('UPDATE push_envelopes SET last_approved_commit=?1 WHERE id=?2')
    .bind(newCommit, envelopeId)
    .run();
}

/** A changed path is covered when it sits under one of the envelope's prefixes. */
export function pathsWithinEnvelope(changedPaths: string[], allowedPaths: string[]): boolean {
  if (changedPaths.length === 0) return true;
  return changedPaths.every((path) =>
    allowedPaths.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
  );
}
