import { describe, expect, it } from 'vitest';
import { summariseCommandOutput } from '../../apps/forge-edge-gateway/src/command-summary';

const VITEST_PASS = `
 ✓ tests/unit/a.test.ts (12 tests) 40ms
 Test Files  74 passed | 1 skipped (75)
      Tests  526 passed | 1 skipped (527)
   Duration  8.9s
`;

const VITEST_FAIL = `
 FAIL  tests/unit/durability.test.ts > durability > refuses to lie
 FAIL  tests/unit/remote-commit.test.ts > commit > rebases
AssertionError: expected false to be true
 Test Files  2 failed | 72 passed (74)
      Tests  3 failed | 524 passed | 1 skipped (528)
`;

describe('summariseCommandOutput', () => {
  it('replaces a passing test log with one line', () => {
    const summary = summariseCommandOutput({ command: 'pnpm test', output: VITEST_PASS, exitCode: 0 })!;
    expect(summary.kind).toBe('tests');
    expect(summary.ok).toBe(true);
    expect(summary.passed).toBe(526);
    expect(summary.failed).toBe(0);
    expect(summary.headline).toMatch(/All tests passed/u);
  });

  it('keeps the failing test names and nothing else', () => {
    const summary = summariseCommandOutput({ command: 'pnpm test', output: VITEST_FAIL, exitCode: 1 })!;
    expect(summary.ok).toBe(false);
    expect(summary.failed).toBe(3);
    expect(summary.passed).toBe(524);
    expect(summary.failures).toHaveLength(2);
    expect(summary.failures?.[0]).toContain('durability.test.ts');
    expect(summary.headline).toBe('3 tests failed, 524 passed.');
  });

  it('summarises TypeScript errors', () => {
    const out = 'src/a.ts(12,5): error TS2345: Argument of type X\nsrc/b.ts(3,1): error TS2304: Cannot find name Y';
    const summary = summariseCommandOutput({ command: 'pnpm typecheck', output: out, exitCode: 2 })!;
    expect(summary.kind).toBe('typecheck');
    expect(summary.failed).toBe(2);
    expect(summary.failures?.[1]).toContain('TS2304');
  });

  it('leaves an unrecognised command alone', () => {
    // Summarising something we do not understand would hide the only output
    // the agent has. Unknown shapes must keep their raw log.
    expect(summariseCommandOutput({ command: 'ls -la', output: 'a\nb\nc', exitCode: 0 })).toBeUndefined();
    expect(summariseCommandOutput({ command: 'pnpm test', output: 'no summary here', exitCode: 0 })).toBeUndefined();
  });

  it('caps how many failures it reports', () => {
    const many = Array.from({ length: 60 }, (_, i) => ` FAIL  tests/t${i}.test.ts > case`).join('\n')
      + '\n      Tests  60 failed | 0 passed (60)';
    const summary = summariseCommandOutput({ command: 'vitest run', output: many, exitCode: 1 })!;
    expect(summary.failed).toBe(60);
    expect(summary.failures!.length).toBeLessThanOrEqual(25);
  });
});
