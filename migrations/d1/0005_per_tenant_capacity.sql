-- Move workspace slots from a global 2-slot pool to a per-tenant model. Each
-- tenant gets its own 1..N slot range so one busy account cannot starve others;
-- a separate global count still bounds total concurrent workspaces (and thus
-- container cost). The old table's slot PRIMARY KEY CHECK(slot IN (1,2)) hard
-- capped two workspaces globally, so the table is rebuilt.
PRAGMA foreign_keys = OFF;

CREATE TABLE workspace_slots_new (
  workspace_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  claimed_at TEXT NOT NULL,
  UNIQUE (tenant_id, slot)
);

-- Preserve currently held slots, attributing each to its owning tenant. Any
-- slot whose workspace row has vanished is dropped (it was already reclaimable).
INSERT OR IGNORE INTO workspace_slots_new (workspace_id, tenant_id, slot, claimed_at)
SELECT s.workspace_id, w.tenant_id, s.slot, s.claimed_at
  FROM workspace_slots AS s
  JOIN workspaces AS w ON w.id = s.workspace_id;

DROP TABLE workspace_slots;
ALTER TABLE workspace_slots_new RENAME TO workspace_slots;

CREATE INDEX IF NOT EXISTS idx_workspace_slots_tenant ON workspace_slots (tenant_id);

PRAGMA foreign_keys = ON;
