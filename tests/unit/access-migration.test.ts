import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Migration 0017 installs the access gate. Getting it wrong locks the owner out
// of their own instance — approved users could still work, but no access request
// could ever be granted because nobody would hold is_owner. Run the real file
// against real SQLite rather than trusting a reading of it.
const MIGRATION = readFileSync('migrations/d1/0017_access_requests.sql', 'utf8');

const USERS_TABLE = `CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  avatar_url TEXT,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

function migrated(users: Array<{ id: string; login: string; created_at: string }>) {
  const db = new DatabaseSync(':memory:');
  db.exec(USERS_TABLE);
  for (const user of users) {
    db.prepare('INSERT INTO users (id, github_user_id, github_login, tenant_id, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(user.id, user.id, user.login, 'ten_1', 'prj_1', user.created_at, user.created_at);
  }
  db.exec(MIGRATION);
  return db;
}

describe('access gate migration', () => {
  it('makes the existing account the owner', () => {
    // The real production shape when this ships: one account, already in use.
    const db = migrated([{ id: 'usr_1', login: 'owner', created_at: '2026-07-12T20:34:52.118Z' }]);
    expect(db.prepare('SELECT access_state AS s, is_owner AS o FROM users WHERE id=?').get('usr_1'))
      .toMatchObject({ s: 'approved', o: 1 });
  });

  it('picks the earliest account when several already exist', () => {
    const db = migrated([
      { id: 'usr_late', login: 'later', created_at: '2026-07-20T00:00:00.000Z' },
      { id: 'usr_first', login: 'founder', created_at: '2026-07-12T00:00:00.000Z' }
    ]);
    const owners = db.prepare('SELECT id FROM users WHERE is_owner=1').all();
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ id: 'usr_first' });
  });

  it('does not lock out anyone already using Forge', () => {
    // Everyone present before the gate existed keeps working; the gate applies
    // to accounts created after it.
    const db = migrated([
      { id: 'usr_1', login: 'a', created_at: '2026-07-12T00:00:00.000Z' },
      { id: 'usr_2', login: 'b', created_at: '2026-07-13T00:00:00.000Z' }
    ]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM users WHERE access_state<>'approved'").get())
      .toMatchObject({ c: 0 });
  });

  it('is safe on an empty database', () => {
    // A fresh instance has no rows to promote; the first sign-in claims
    // ownership instead, so this must simply match nothing.
    const db = migrated([]);
    expect(db.prepare('SELECT COUNT(*) AS c FROM users').get()).toMatchObject({ c: 0 });
  });
});
