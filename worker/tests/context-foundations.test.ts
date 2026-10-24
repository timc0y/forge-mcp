import { describe, expect, it } from 'vitest';
import { mapBounded, requirePath, requireSha, sourceRange, utf8Bytes } from '../src/evidence';
import { safeMetricProperties } from '../src/analytics';

describe('context evidence foundations', () => {
  it('keeps offsets distinct from bytes and refuses split Unicode', () => {
    expect(utf8Bytes('a😀')).toBe(5);
    expect(sourceRange('a😀\r\nx', 1, 3)).toEqual({ start: 1, end: 3, startLine: 1, endLine: 1 });
    expect(() => sourceRange('a😀x', 2, 3)).toThrow(/Unicode/);
    expect(() => sourceRange('abc', 2, 1)).toThrow(/range/);
  });
  it('refuses traversals and mutable revision identities', () => {
    for (const path of ['../secret', '/root', 'a//b', 'a\\b', 'a/./b']) expect(() => requirePath(path)).toThrow();
    expect(requirePath('src/a.ts')).toBe('src/a.ts');
    expect(() => requireSha('main')).toThrow();
    expect(requireSha('a'.repeat(40))).toHaveLength(40);
  });
  it('bounds concurrency and preserves input order', async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapBounded([3, 2, 1, 0, 4], async (item) => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, item));
      active--;
      return item * 2;
    }, 2);
    expect(result).toEqual([6, 4, 2, 0, 8]);
    expect(maximum).toBeLessThanOrEqual(2);
  });
  it('rejects private content even when accidentally passed to observations', () => {
    expect(safeMetricProperties({ repo: 'private/project', query: 'secret', ms: 3, ok: true, tool: 'forge_read', code: 'https://secret.invalid' })).toEqual({ ms: 3, ok: true, tool: 'forge_read' });
  });
});
