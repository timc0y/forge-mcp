import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { Env } from '../../src/env';

/** Execute production SQL rather than reproducing admission policy in a fake. */
export function semanticDatabase(): D1Database {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const path of readdirSync(migrations).filter((path) => path.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(path, migrations), 'utf8'));
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const execute = () => {
      const result = db.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) }, results: [] };
    };
    return {
      bind: (...next: SQLInputValue[]) => prepare(sql, next), execute,
      run: async () => execute(),
      first: async () => db.prepare(sql).get(...values) ?? null,
      all: async () => ({ success: true, results: db.prepare(sql).all(...values), meta: {} })
    };
  }
  return {
    prepare,
    async batch(statements: Array<{ execute: () => unknown }>) {
      db.exec('BEGIN');
      try { const results = statements.map((statement) => statement.execute()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  } as unknown as D1Database;
}

export function semanticEnv(extra: Partial<Env> = {}): Env {
  return { METADATA: semanticDatabase(), TYPESAFE_API_KEY: 'synthetic-key', TYPESAFE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/ai/run', ...extra } as Env;
}
