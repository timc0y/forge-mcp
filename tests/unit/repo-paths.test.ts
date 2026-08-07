import { describe, expect, it } from 'vitest';
import { forgeTools } from '@forge/mcp-core';
import { normalizeRepoPath, readableFile, toContainerPath } from '../../apps/forge-edge-gateway/src/repo-paths';

describe('normalizeRepoPath', () => {
  it('accepts repo-relative and absolute repository paths identically', () => {
    expect(normalizeRepoPath('src/a.ts')).toBe('src/a.ts');
    expect(normalizeRepoPath('/workspace/repo/src/a.ts')).toBe('src/a.ts');
    expect(normalizeRepoPath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeRepoPath('/workspace/repo')).toBe('');
  });

  it('refuses absolute paths outside the checkout, including sibling-prefix tricks', () => {
    for (const bad of [
      '/workspace',
      '/workspace/',
      '/workspace/forge',
      '/workspace/forge/metadata.json',
      '/workspace/tmp/result',
      '/workspace/repository/secret',
      '/workspace/repo-evil/secret',
      '/etc/passwd'
    ]) {
      expect(() => normalizeRepoPath(bad), bad).toThrowError(/workspace\/repo/);
    }
  });

  it('refuses traversal and NUL bytes in either path form', () => {
    // A commit is built from these paths verbatim, so an escape here would
    // write outside the repo rather than fail.
    for (const bad of [
      '../secrets',
      'src/../../etc/passwd',
      'a/..',
      '..',
      '/workspace/repo/../forge/metadata.json',
      '/workspace/repo/src/../../forge/metadata.json',
      'src/\0secret',
      '/workspace/repo/src/\0secret',
      ''
    ]) {
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

  it('leaves an absolute repository path alone', () => {
    expect(toContainerPath('/workspace/repo/src/a.ts')).toBe('/workspace/repo/src/a.ts');
    expect(toContainerPath('/workspace/repo')).toBe('/workspace/repo');
  });

  it('refuses every absolute path outside the checkout, traversal, and NUL bytes', () => {
    for (const bad of [
      '/workspace',
      '/workspace/forge',
      '/workspace/tmp/result',
      '/workspace/repository/secret',
      '/workspace/repo-evil/secret',
      '/workspace/repo/../forge/metadata.json',
      '../etc/passwd',
      'src/../../etc/passwd',
      'src/\0secret'
    ]) {
      expect(() => toContainerPath(bad), bad).toThrow();
    }
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

describe('tool path defaults resolve to somewhere real', () => {
  it('accepts paths that normalize to the repository checkout', () => {
    const readTool = forgeTools.find((tool) => tool.name === 'forge_read');
    const shape = readTool?.inputSchema as { paths: { safeParse(v: unknown): { success: boolean } } };
    expect(shape.paths.safeParse(['src/index.ts']).success).toBe(true);
    expect(shape.paths.safeParse(['/workspace/repo/src/index.ts']).success).toBe(true);
  });

  it('leaves every other repo-relative default resolvable too', () => {
    // Any tool defaulting a path must land inside the checkout, not beside it.
    for (const tool of forgeTools) {
      const shape = tool.inputSchema as Record<string, { safeParse?(v: unknown): { data?: unknown } }>;
      for (const [field, schema] of Object.entries(shape)) {
        if (field !== 'path' && field !== 'cwd') continue;
        const defaulted = schema.safeParse?.(undefined)?.data;
        if (typeof defaulted !== 'string') continue;
        expect(toContainerPath(defaulted), `${tool.name}.${field}`).toMatch(/^\/workspace\/repo(\/|$)/u);
        expect(toContainerPath(defaulted), `${tool.name}.${field}`).not.toMatch(/\/repo\/repo/u);
      }
    }
  });
});
