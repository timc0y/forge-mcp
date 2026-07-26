PRAGMA foreign_keys = ON;

-- Durable coding-session records that survive workspace destruction,
-- MCP reconnects and ChatGPT context compression. A task references at most
-- one workspace at a time but outlives every workspace it uses.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  goal TEXT NOT NULL,
  state TEXT NOT NULL,
  branch TEXT,
  workspace_id TEXT,
  preview_id TEXT,
  latest_diff_hash TEXT,
  revision INTEGER NOT NULL,
  -- Durable resume payload (decisions, non-goals, files read/changed, checks,
  -- evidence ids, outstanding work) stored as bounded JSON. Never holds secrets,
  -- full source, complete logs or raw diffs.
  document TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_tenant_state ON tasks(tenant_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
