PRAGMA foreign_keys = ON;

-- Immutable record of what an agent actually did — as distinct from what a
-- task/session summary later claims it did. Append-only; no UPDATE/DELETE
-- path exists in AuditStore. Covers only mutating, consequential actions
-- (push, PR create, task finish, workspace destroy), not every tool call —
-- that volume belongs in telemetry (PostHog), not this durable trail.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  -- Bounded JSON payload, secret-redacted before storage. Never holds full
  -- diffs, source, or raw command output.
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_time ON audit_events(tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_task ON audit_events(task_id);
