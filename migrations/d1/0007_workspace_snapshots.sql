-- Records the R2 object holding a workspace's saved state (a tar of /workspace)
-- so an idle-reaped workspace can be restored on next use instead of rebuilt
-- from scratch. Survives workspace destruction (unlike the workspaces row), so
-- it must be a separate table keyed by workspace id.
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  workspace_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL
);
