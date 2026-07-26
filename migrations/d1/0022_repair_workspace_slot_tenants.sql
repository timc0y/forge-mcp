-- 0019 rebuilt workspace_slots while raising the slot count, but accidentally
-- dropped the tenant dimension introduced by 0005. A production database that
-- has applied 0019 therefore cannot reserve a workspace at all: capacity.ts
-- correctly writes tenant_id, while the persisted table does not have it.
--
-- Repair forward rather than editing the already-applied migration. The join
-- keeps every real held slot and recovers its authoritative tenant from the
-- workspace row; an orphaned historical slot is intentionally discarded since
-- it cannot represent recoverable work.
PRAGMA foreign_keys = OFF;

CREATE TABLE workspace_slots_repaired (
  workspace_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  claimed_at TEXT NOT NULL,
  UNIQUE (tenant_id, slot)
);

INSERT OR IGNORE INTO workspace_slots_repaired (workspace_id, tenant_id, slot, claimed_at)
SELECT s.workspace_id, w.tenant_id, s.slot, s.claimed_at
  FROM workspace_slots AS s
  JOIN workspaces AS w ON w.id = s.workspace_id;

DROP TABLE workspace_slots;
ALTER TABLE workspace_slots_repaired RENAME TO workspace_slots;

CREATE INDEX IF NOT EXISTS idx_workspace_slots_tenant ON workspace_slots (tenant_id);

PRAGMA foreign_keys = ON;
