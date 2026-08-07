PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chat_operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  repository TEXT,
  repository_ref TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'screenshot', 'deploy', 'submit')),
  state TEXT NOT NULL CHECK (state IN ('running', 'approval_required', 'completed', 'failed', 'expired')),
  summary TEXT NOT NULL,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_operations_repository
  ON chat_operations(tenant_id, project_id, repository, updated_at DESC);
