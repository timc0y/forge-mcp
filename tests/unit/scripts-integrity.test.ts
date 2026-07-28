import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Scripts Integrity Suite', () => {
  const root = resolve(import.meta.dirname, '../..');

  it('check-migrations passes without errors', () => {
    const output = execSync('npx tsx scripts/check-migrations.ts', { cwd: root, encoding: 'utf8' });
    expect(output).toContain('D1 migration check passed');

    // Derived from the files on disk, not pinned to a number. A hardcoded
    // '0001..0026' broke on every legitimately added migration while proving
    // nothing — the same shape of mistake as a test that pinned a removed tool
    // name and so held the bug open instead of catching it. What matters is
    // that the sequence has no gaps, and that is what this asserts.
    const migrations = readdirSync(resolve(root, 'migrations/d1'))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const last = migrations.at(-1)?.slice(0, 4);
    expect(last, 'no migrations found').toBeDefined();
    expect(output).toContain(`sequential 0001..${last}`);
    expect(migrations).toHaveLength(Number(last));
  });

  it('check-wiring passes without errors', () => {
    const output = execSync('npx tsx scripts/check-wiring.ts', { cwd: root, encoding: 'utf8' });
    expect(output).toContain('Wiring check passed');
  });

  it('check-boundaries passes without errors', () => {
    const output = execSync('npx tsx scripts/check-boundaries.ts', { cwd: root, encoding: 'utf8' });
    expect(output).toContain('Dependency boundaries valid across');
  });
});
