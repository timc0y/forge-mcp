import { describe, expect, it } from 'vitest';
import { normalizeRepoPath } from '../../apps/forge-edge-gateway/src/repo-paths';

describe('normalizeRepoPath', () => {
  it('accepts repo-relative and absolute workspace paths identically', () => {
    expect(normalizeRepoPath('src/a.ts')).toBe('src/a.ts');
    expect(normalizeRepoPath('/workspace/repo/src/a.ts')).toBe('src/a.ts');
    expect(normalizeRepoPath('./src/a.ts')).toBe('src/a.ts');
  });

  it('refuses anything that leaves the repository', () => {
    // A commit is built from these paths verbatim, so an escape here would
    // write outside the repo rather than fail.
    for (const bad of ['../secrets', 'src/../../etc/passwd', 'a/..', '..', '']) {
      expect(() => normalizeRepoPath(bad), bad).toThrow();
    }
  });
});
