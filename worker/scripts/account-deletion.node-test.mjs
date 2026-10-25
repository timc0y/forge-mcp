import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const runbook = fs.readFileSync(new URL('../../docs/account-deletion.md', import.meta.url), 'utf8');
const sqlBlocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)].map(match => match[1]);
const deletion = sqlBlocks.find(sql => sql.startsWith('BEGIN TRANSACTION;'));
const verification = sqlBlocks.find(sql => sql.includes('users_remaining'));
const migrations = new URL('../migrations/', import.meta.url);
const ownedTables = ['approvals', 'capture_usage', 'captures', 'oauth_codes', 'oauth_refresh_tokens', 'users'];

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of fs.readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(file, migrations), 'utf8'));
  db.exec("INSERT INTO oauth_clients VALUES ('client', 'Fixture client', '[]', '2026-10-23')");
  for (const id of ['FORGE_USER_ID', 'OTHER_USER_ID']) {
    db.prepare('INSERT INTO users (id, github_user_id, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, id, id, '2026-10-23', '2026-10-23');
    db.prepare("INSERT INTO approvals (id, user_id, act, repo_owner, repo_name, branch, head_sha, evidence_json, state, created_at, expires_at) VALUES (?, ?, 'discard', 'owner', 'fixture', 'forge', 'sha', '{}', 'pending', '2026-10-23', '2026-10-24')").run(id, id);
    db.prepare("INSERT INTO oauth_codes VALUES (?, 'client', 'https://client.invalid', 'challenge', ?, '2026-10-24', NULL)").run(id, id);
    db.prepare("INSERT INTO oauth_refresh_tokens (token_hash, family_id, user_id, client_id, key_tag, expires_at, created_at) VALUES (?, ?, ?, 'client', 'tag', '2026-10-24', '2026-10-23')").run(id, id, id);
    db.prepare("INSERT INTO capture_usage VALUES (?, '2026-10-23', 1)").run(id);
    db.prepare("INSERT INTO captures VALUES (?, ?, ?, '2026-08-20', '2026-09-20')").run(id, id, `historical/${id}`);
  }
  return db;
}

test('historical captures ownership blocks the old account deletion SQL', () => {
  const db = fixture();
  try {
    assert.ok(deletion);
    const oldSql = deletion.replace("DELETE FROM captures WHERE user_id = 'FORGE_USER_ID';\n", '');
    assert.notEqual(oldSql, deletion);
    assert.throws(() => db.exec(oldSql), /FOREIGN KEY constraint failed/);
    db.exec('ROLLBACK');
    assert.equal(db.prepare("SELECT count(*) AS n FROM captures WHERE user_id = 'FORGE_USER_ID'").get().n, 1);
  } finally { db.close(); }
});

test('documented SQL clears every owned table and preserves another user', () => {
  const db = fixture();
  try {
    const inventory = db.prepare("SELECT DISTINCT m.name FROM sqlite_schema m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND (p.name='user_id' OR (m.name='users' AND p.name='id')) ORDER BY m.name").all().map(row => row.name);
    assert.deepEqual(inventory, ownedTables);
    const fkOwners = db.prepare("SELECT DISTINCT m.name FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) f WHERE f.\"table\"='users' ORDER BY m.name").all().map(row => row.name);
    assert.deepEqual(fkOwners, ownedTables.filter(table => table !== 'users'));
    db.exec(deletion);
    for (const sql of verification.split(';').map(sql => sql.trim()).filter(Boolean)) {
      const rows = db.prepare(sql).all();
      if (sql.startsWith('PRAGMA')) assert.deepEqual(rows, []);
      else assert.equal(Object.values(rows[0])[0], 0);
    }
    for (const table of inventory) {
      const column = table === 'users' ? 'id' : 'user_id';
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = 'OTHER_USER_ID'`).get().n, 1);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM oauth_clients').get().n, 1);
  } finally { db.close(); }
});
