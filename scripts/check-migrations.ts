#!/usr/bin/env tsx
/**
 * Lightweight, dependency-free guard for the D1 migrations directory.
 *
 * `wrangler deploy` does NOT apply D1 migrations — only `wrangler d1 migrations
 * apply` does (the root `deploy` script runs that first via `predeploy`).
 * Because migrations are applied out-of-band, a missing, duplicated, or
 * misnumbered migration file is easy to ship unnoticed. This check fails CI when
 * the `migrations/d1/*.sql` files are not numbered as a strict, gap-free,
 * duplicate-free sequence starting at 0001.
 *
 * Operational note: applying migrations against the remote DB uses the
 * account_id from infra/wrangler/forge.jsonc; when a token can see multiple
 * Cloudflare accounts, set CLOUDFLARE_ACCOUNT_ID to disambiguate. No secrets
 * are needed for THIS check — it only inspects filenames.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../migrations/d1');

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const errors: string[] = [];
const seen = new Map<number, string>();

for (const name of files) {
  const match = /^(\d{4})_[^/]+\.sql$/.exec(name);
  if (!match) {
    errors.push(`Migration "${name}" does not match NNNN_description.sql`);
    continue;
  }
  const num = Number(match[1]);
  if (seen.has(num)) {
    errors.push(`Duplicate migration number ${match[1]}: "${seen.get(num)}" and "${name}"`);
    continue;
  }
  seen.set(num, name);
}

const numbers = [...seen.keys()].sort((a, b) => a - b);
for (let i = 0; i < numbers.length; i += 1) {
  const expected = i + 1;
  if (numbers[i] !== expected) {
    errors.push(
      `Migration numbering gap: expected ${String(expected).padStart(4, '0')} but found ${String(numbers[i]).padStart(4, '0')}`
    );
    break;
  }
}

if (numbers.length === 0) {
  errors.push('No migration files found in migrations/d1');
}

if (errors.length > 0) {
  console.error('D1 migration check failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`D1 migration check passed: ${numbers.length} migrations, sequential 0001..${String(numbers.at(-1)).padStart(4, '0')}`);
