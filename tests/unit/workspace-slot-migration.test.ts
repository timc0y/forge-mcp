import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// Production applied 0019 with a workspace_slots table that accidentally lost
// tenant_id. This test runs the forward-only repair against that exact
// pre-repair schema so a future schema change cannot reintroduce a deployment
// where every workspace create fails at runtime.
const REPAIR = readFileSync('migrations/d1/0022_repair_workspace_slot_tenants.sql', 'utf8');

function preRepairDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE workspace_slots (
      slot INTEGER PRIMARY KEY CHECK (slot IN (1, 2, 3, 4, 5)),
      workspace_id TEXT NOT NULL UNIQUE,
      claimed_at TEXT NOT NULL
    );
  `);
  database.prepare('INSERT INTO workspaces (id, tenant_id, state) VALUES (?, ?, ?)').run('ws_a', 'ten_a', 'ready');
  database.prepare('INSERT INTO workspaces (id, tenant_id, state) VALUES (?, ?, ?)').run('ws_b', 'ten_b', 'ready');
  database.prepare('INSERT INTO workspace_slots (slot, workspace_id, claimed_at) VALUES (?, ?, ?)').run(1, 'ws_a', '2026-07-26T19:00:00.000Z');
  database.prepare('INSERT INTO workspace_slots (slot, workspace_id, claimed_at) VALUES (?, ?, ?)').run(2, 'ws_b', '2026-07-26T19:01:00.000Z');
  // A slot whose workspace disappeared cannot be attributed safely and must
  // never consume a tenant's capacity after the repair.
  database.prepare('INSERT INTO workspace_slots (slot, workspace_id, claimed_at) VALUES (?, ?, ?)').run(3, 'ws_orphan', '2026-07-26T19:02:00.000Z');
  return database;
}

describe('workspace slot tenant repair migration', () => {
  it('restores per-tenant capacity while preserving real held slots', () => {
    const database = preRepairDatabase();
    database.exec(REPAIR);

    expect(database.prepare('PRAGMA table_info(workspace_slots)').all().map((row) => (row as { name: string }).name))
      .toEqual(['workspace_id', 'tenant_id', 'slot', 'claimed_at']);
    expect(database.prepare('SELECT workspace_id, tenant_id, slot FROM workspace_slots ORDER BY workspace_id').all())
      .toEqual([
        { workspace_id: 'ws_a', tenant_id: 'ten_a', slot: 1 },
        { workspace_id: 'ws_b', tenant_id: 'ten_b', slot: 2 }
      ]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workspace_slots_tenant'").get())
      .toMatchObject({ name: 'idx_workspace_slots_tenant' });
  });
});
