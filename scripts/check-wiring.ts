#!/usr/bin/env tsx
/**
 * Lightweight, dependency-free wiring guard (regex-level, like check-migrations).
 *
 * Two drifts the TypeScript compiler does NOT catch:
 *
 * 1. The v1 adapter classifies tools through untyped string-literal sets
 *    (RETRY_SAFE_MUTATIONS, TRUE_READS, OPEN_WORLD) and a
 *    TOOL_INVOCATION_STATUS map. A tool renamed in mcp-core silently loses its
 *    annotations/status because these are plain strings. We assert every
 *    forge_* name in those sets is a real tool.
 *
 * 2. A D1 table can be shipped in a migration and then never read/written
 *    (an orphan table) — or referenced under a typo. We assert every
 *    `CREATE TABLE` name appears somewhere in packages/ or apps/ source.
 *
 * (Tool<->handler parity is already enforced by the compiler: handlers() is
 * typed Record<ForgeToolName, ForgeToolHandler>, so that is deliberately not
 * re-checked here.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const errors: string[] = [];

// --- 1. adapter behavior sets reference only real tool names ---------------

const toolSource = readFileSync(resolve(root, 'packages/mcp-core/src/index.ts'), 'utf8');
const toolNames = new Set([...toolSource.matchAll(/name:\s*'(forge_[a-z_]+)'/g)].map((m) => m[1]));
if (toolNames.size === 0) errors.push('Found no forge_* tool names in packages/mcp-core — check the regex.');

const adapterSource = readFileSync(resolve(root, 'packages/mcp-adapter-v1/src/index.ts'), 'utf8');

// The four Set literals are flat string arrays — a lazy match to the closing
// `]` captures every name.
const SETS = ['RETRY_SAFE_MUTATIONS', 'TRUE_READS', 'OPEN_WORLD'];
for (const setName of SETS) {
  const block = new RegExp(`${setName}[^\\[]*\\[([\\s\\S]*?)\\]`).exec(adapterSource);
  if (!block) { errors.push(`Adapter set "${setName}" not found in mcp-adapter-v1.`); continue; }
  for (const m of block[1].matchAll(/'(forge_[a-z_]+)'/g)) {
    if (!toolNames.has(m[1])) errors.push(`Adapter set "${setName}" references unknown tool "${m[1]}".`);
  }
}

// TOOL_INVOCATION_STATUS is an object whose values are nested `{...}`, so match
// through its closing `};` and validate the object KEYS (each `forge_*:`).
const statusBlock = /TOOL_INVOCATION_STATUS[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(adapterSource);
if (!statusBlock) {
  errors.push('Adapter map "TOOL_INVOCATION_STATUS" not found in mcp-adapter-v1.');
} else {
  const keys = [...statusBlock[1].matchAll(/(forge_[a-z_]+):/g)].map((m) => m[1]);
  if (keys.length === 0) errors.push('TOOL_INVOCATION_STATUS matched no forge_* keys — check the regex.');
  for (const key of keys) {
    if (!toolNames.has(key)) errors.push(`TOOL_INVOCATION_STATUS references unknown tool "${key}".`);
  }
}

// --- 2. every migration table is referenced in source ----------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const sourceBlob = walk(resolve(root, 'packages'))
  .concat(walk(resolve(root, 'apps')))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

// Replay CREATE / DROP / RENAME across migrations (in numeric order) to get the
// FINAL live tables, so rebuild temp tables (e.g. workspace_slots_new renamed
// to workspace_slots) and dropped tables are not mistaken for orphans.
const migrationsDir = resolve(root, 'migrations/d1');
const live = new Set<string>();
for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(migrationsDir, name), 'utf8');
  for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)) live.add(m[1]);
  for (const m of sql.matchAll(/DROP TABLE (?:IF EXISTS )?(\w+)/gi)) live.delete(m[1]);
  for (const m of sql.matchAll(/ALTER TABLE (\w+) RENAME TO (\w+)/gi)) { live.delete(m[1]); live.add(m[2]); }
}
// Orphan tables are a WARNING, not a failure: a table can be legitimately
// reserved or read by out-of-band tooling. Adapter-set drift above is a real
// bug and hard-fails. A NEW orphan still shows up loudly in CI logs.
const orphans = [...live].filter((t) => !sourceBlob.includes(t));

// --- report ----------------------------------------------------------------

if (errors.length > 0) {
  console.error('Wiring check failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (orphans.length > 0) {
  console.warn(`Wiring check warning: ${orphans.length} D1 table(s) declared but not referenced in source: ${orphans.join(', ')}.`);
}
console.log(`Wiring check passed: ${toolNames.size} tools, ${SETS.length} adapter sets + status map, ${live.size} live D1 tables (${orphans.length} unreferenced).`);
