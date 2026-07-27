import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('Scripts Integrity Suite', () => {
  const root = resolve(import.meta.dirname, '../..');

  it('check-migrations passes without errors', () => {
    const output = execSync('npx tsx scripts/check-migrations.ts', { cwd: root, encoding: 'utf8' });
    expect(output).toContain('D1 migration check passed');
    expect(output).toContain('sequential 0001..0024');
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
