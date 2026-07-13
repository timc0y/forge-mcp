PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace_slots (
  slot INTEGER PRIMARY KEY CHECK (slot IN (1, 2)),
  workspace_id TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL
);

INSERT OR IGNORE INTO workspace_slots (slot, workspace_id, claimed_at)
SELECT 1, id, updated_at FROM workspaces
WHERE state NOT IN ('suspended', 'failed', 'destroying', 'destroyed')
ORDER BY created_at LIMIT 1;

INSERT OR IGNORE INTO workspace_slots (slot, workspace_id, claimed_at)
SELECT 2, id, updated_at FROM workspaces
WHERE state NOT IN ('suspended', 'failed', 'destroying', 'destroyed')
  AND id NOT IN (SELECT workspace_id FROM workspace_slots)
ORDER BY created_at LIMIT 1;
