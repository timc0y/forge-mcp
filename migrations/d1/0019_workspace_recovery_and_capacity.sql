CREATE TABLE workspace_slots_next (
  slot INTEGER PRIMARY KEY CHECK (slot IN (1, 2, 3, 4, 5)),
  workspace_id TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL
);

INSERT INTO workspace_slots_next (slot, workspace_id, claimed_at)
SELECT slot, workspace_id, claimed_at FROM workspace_slots;

DROP TABLE workspace_slots;
ALTER TABLE workspace_slots_next RENAME TO workspace_slots;

ALTER TABLE workspaces ADD COLUMN last_pushed_commit TEXT;
ALTER TABLE workspaces ADD COLUMN last_pushed_branch TEXT;
