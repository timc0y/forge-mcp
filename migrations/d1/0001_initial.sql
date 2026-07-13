PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS github_installations (
  installation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  account_login TEXT NOT NULL,
  permission_snapshot TEXT NOT NULL,
  last_verified_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  installation_id TEXT REFERENCES github_installations(installation_id),
  authorization_state TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  UNIQUE(provider, owner, name, tenant_id)
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  requested_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  persistence_mode TEXT NOT NULL,
  runtime_profile TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  current_commit TEXT,
  current_branch TEXT,
  idle_deadline TEXT,
  active_snapshot_id TEXT
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  UNIQUE(tenant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT,
  operation_id TEXT,
  requested_action TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk_category TEXT NOT NULL,
  request_payload TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  maturity TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  owner TEXT NOT NULL,
  review_at TEXT,
  fallback TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_state ON workspaces(tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_operations_workspace ON operations(workspace_id, started_at);
CREATE INDEX IF NOT EXISTS idx_approvals_workspace_state ON approvals(workspace_id, state);
