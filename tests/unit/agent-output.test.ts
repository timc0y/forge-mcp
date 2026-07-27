import { describe, expect, it } from 'vitest';
import {
  AGENT_OUTPUT_SPILL_BYTES,
  filterUnifiedDiff,
  tailBytes,
  utf8Bytes
} from '../../packages/mcp-core/src/agent-output';

describe('agent output helpers', () => {
  it('filters unified diffs to requested paths', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      ''
    ].join('\n');
    const filtered = filterUnifiedDiff(patch, ['src/a.ts']);
    expect(filtered).toContain('src/a.ts');
    expect(filtered).not.toContain('src/b.ts');
  });

  it('rejects filters that remove every hunk', () => {
    expect(() => filterUnifiedDiff('diff --git a/a.ts b/a.ts\n', ['missing.ts'])).toThrow(/No patch hunks/);
  });

  it('tails by utf8 bytes', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(tailBytes('abcdefghij', 4)).toBe('ghij');
    expect(AGENT_OUTPUT_SPILL_BYTES).toBe(20_480);
  });
});
