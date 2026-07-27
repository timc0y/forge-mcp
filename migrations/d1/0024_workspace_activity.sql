PRAGMA foreign_keys = ON;

-- Append-only MCP tool trail for operator dashboards and forge_observer_* tools.
-- High volume: indexed by tenant time; optional workspace filter.
CREATE TABLE IF NOT EXISTS workspace_activity (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  workspace_id TEXT,
  tool TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_activity_tenant_time
  ON workspace_activity(tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_activity_workspace_time
  ON workspace_activity(workspace_id, occurred_at DESC);
