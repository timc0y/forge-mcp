import { describe, expect, it } from 'vitest';
import { normalizeRepoPath, readableFile, toContainerPath } from '../../apps/forge-edge-gateway/src/repo-paths';

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

describe('toContainerPath', () => {
  it('accepts the relative form forge_edit and forge_files_list report', () => {
    // The gap this closes: forge_edit answered paths:["src/a.ts"], and passing
    // that exact string to forge_files_read was rejected for lacking a
    // /workspace prefix. One tool's output could not be the next one's input.
    expect(toContainerPath('src/a.ts')).toBe('/workspace/repo/src/a.ts');
    expect(toContainerPath('./src/a.ts')).toBe('/workspace/repo/src/a.ts');
    expect(toContainerPath('  src/a.ts  ')).toBe('/workspace/repo/src/a.ts');
  });

  it('leaves an absolute workspace path alone', () => {
    expect(toContainerPath('/workspace/repo/src/a.ts')).toBe('/workspace/repo/src/a.ts');
    expect(toContainerPath('/workspace/repo')).toBe('/workspace/repo');
    expect(toContainerPath('/workspace')).toBe('/workspace');
  });

  it('still refuses to escape the repository', () => {
    expect(() => toContainerPath('../etc/passwd')).toThrow();
    expect(() => toContainerPath('src/../../etc/passwd')).toThrow();
  });

  it('round-trips a listing entry back into a read', () => {
    const root = '/workspace/repo';
    const listed = '/workspace/repo/tests/unit/a.test.ts';
    const relative = listed.slice(`${root}/`.length);
    expect(relative).toBe('tests/unit/a.test.ts');
    expect(toContainerPath(relative)).toBe(listed);
  });
});

describe('readableFile', () => {
  it('drops the hash no tool input has ever accepted', () => {
    // It was described as being "for a conflict-safe later edit", but the read
    // guard is server-side and no schema takes a hash — so it cost 66 bytes a
    // file and pointed at a workflow the agent could not carry out.
    const read = readableFile({
      path: '/workspace/repo/src/a.ts',
      content: 'x',
      sha256: 'f'.repeat(64),
      sizeBytes: 1
    });
    expect(read).toEqual({ path: 'src/a.ts', content: 'x', sizeBytes: 1 });
  });

  it('reports the path in the form forge_edit accepts', () => {
    expect(readableFile({ path: '/workspace/repo/a.ts' }).path).toBe('a.ts');
  });
});
