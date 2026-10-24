import { describe, expect, it } from 'vitest';
import { commitFiles } from '../src/write';
import type { FileWrite, GitHubRequest } from '../src/contracts';

const repo = { owner: 'alice', name: 'demo' }, api = '/repos/alice/demo';
const B = 'b'.repeat(40), O = 'a'.repeat(40), D = 'd'.repeat(40), F = 'f'.repeat(40);
const reply = (json: unknown, status = 200) => ({ status, json, text: '', headers: new Headers() });
type Entry = { path: string; mode: string; type: string; sha: string };

function race(mode: string) {
  let live = O, reads = 0, mutations = 0, made = 0;
  const calls: string[] = [], contentRefs: string[] = [];
  const blobs = new Map([['original', 'base\nfeature original\n'], ['base', 'base\n']]);
  const trees = new Map<string, Entry[]>([
    ['tree-O', [{ path: 'note.md', mode: '100644', type: 'blob', sha: 'original' }]],
    ['tree-B', [{ path: 'note.md', mode: '100644', type: 'blob', sha: 'base' }]],
    ['tree-D', [{ path: 'note.md', mode: '100644', type: 'blob', sha: 'base' }, { path: 'other.md', mode: '100644', type: 'blob', sha: 'base' }]],
    ['tree-F', [{ path: 'note.md', mode: '100644', type: 'blob', sha: 'original' }, { path: 'other.md', mode: '100644', type: 'blob', sha: 'base' }]]
  ]);
  const commits = new Map<string, { parent: string | null; tree: string }>([
    [B, { parent: null, tree: 'tree-B' }], [O, { parent: B, tree: 'tree-O' }],
    [D, { parent: B, tree: 'tree-D' }], [F, { parent: O, tree: 'tree-F' }]
  ]);
  const ancestor = (older: string, newer: string): boolean => {
    for (let node: string | null = newer; node; node = commits.get(node)!.parent) if (node === older) return true;
    return false;
  };
  const gh: GitHubRequest = async (path, init) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === api) return reply({ node_id: 'repo-id' });
    if (path === `${api}/git/ref/heads/main`) {
      if (++reads === 2 && mode === 'retry-rewind') live = B;
      return reply({ object: { sha: live } });
    }
    if (path.includes('/contents/note.md?')) {
      contentRefs.push(path.split('ref=')[1]!);
      return reply({ type: 'file', encoding: 'base64', content: btoa(blobs.get('original')!), size: blobs.get('original')!.length });
    }
    if (path.includes('/git/commits/')) return reply({ tree: { sha: commits.get(path.split('/').at(-1)!)!.tree } });
    if (path.includes('/git/trees/')) return reply({ tree: trees.get(path.split('/').at(-1)!), truncated: false });
    if (path === `${api}/git/blobs`) { blobs.set('candidate', (init!.body as any).content); return reply({ sha: 'candidate' }, 201); }
    if (path === `${api}/git/trees`) {
      const body = init!.body as { base_tree: string; tree: Entry[] };
      const tree = `new-tree-${++made}`;
      trees.set(tree, [...trees.get(body.base_tree)!.filter((entry) => !body.tree.some((change) => change.path === entry.path)), ...body.tree]);
      return reply({ sha: tree }, 201);
    }
    if (path === `${api}/git/commits`) {
      const body = init!.body as { parents: string[]; tree: string };
      const sha = String(made).repeat(40);
      commits.set(sha, { parent: body.parents[0]!, tree: body.tree });
      return reply({ sha }, 201);
    }
    if (path.includes('/compare/')) {
      const [from, to] = path.split('/compare/')[1]!.split('...') as [string, string];
      const ahead = ancestor(from, to), behind = ancestor(to, from);
      return reply({ status: ahead ? 'ahead' : behind ? 'behind' : 'diverged', ahead_by: ahead || !behind ? 1 : 0, behind_by: ahead ? 0 : 1, files: ahead ? [{ filename: 'other.md' }] : behind ? [] : [{ filename: 'other.md' }] });
    }
    if (path === '/graphql') {
      const update = (init!.body as any).variables.input.refUpdates[0];
      mutations++;
      if (mutations === 1) live = mode === 'initial-rewind' ? B : mode === 'forward' || mode === 'second-rewind' ? F : D;
      if (mutations === 2 && mode === 'second-rewind') live = O;
      // Provider checks both expected-head equality and fast-forward ancestry.
      if (live !== update.beforeOid || (!update.force && !ancestor(live, update.afterOid))) return reply({ data: { updateRefs: null }, errors: [{ type: 'UNPROCESSABLE', path: ['updateRefs'] }] });
      live = update.afterOid;
      return reply({ data: { updateRefs: { clientMutationId: null } } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return { gh, calls, contentRefs, live: () => live, mutations: () => mutations, trees, commits, blobs };
}

describe('actual-source rewind and divergence audit scenarios', () => {
  it.each(['initial-rewind', 'retry-rewind', 'diverged', 'second-rewind'])('does not restore removed source after %s', async (mode) => {
    const fixture = race(mode);
    await expect(commitFiles(fixture.gh, repo, 'main', 'main', 'Edit feature', [{ path: 'note.md', replace: [{ old: 'feature original', new: 'edited feature' }] }])).rejects.toMatchObject({ code: 'FORGE_CONFLICT' });
    expect(fixture.live()).toBe(mode === 'diverged' ? D : mode === 'second-rewind' ? O : B);
    expect(fixture.mutations()).toBe(mode === 'second-rewind' ? 2 : 1);
    expect(fixture.contentRefs).toEqual([O]);
    expect(fixture.calls.some((call) => call.startsWith('PATCH '))).toBe(false);
  });

  it('reapplies an unrelated forward change and atomically commits on that head', async () => {
    const fixture = race('forward');
    const receipt = await commitFiles(fixture.gh, repo, 'main', 'main', 'Edit feature', [{ path: 'note.md', replace: [{ old: 'feature original', new: 'edited feature' }] }]);
    expect(receipt).toMatchObject({ outcome: 'committed', sha: fixture.live() });
    const landed = fixture.commits.get(fixture.live())!;
    expect(landed.parent).toBe(F);
    const tree = fixture.trees.get(landed.tree)!;
    expect(tree.some((entry) => entry.path === 'other.md')).toBe(true);
    expect(fixture.blobs.get(tree.find((entry) => entry.path === 'note.md')!.sha)).toBe('base\nedited feature\n');
    expect(fixture.mutations()).toBe(2);
  });

  it('resolves source at a concurrently created branch before attempting its guarded update', async () => {
    const fixture = race('forward');
    let branch: string | null = null, creations = 0;
    const gh: GitHubRequest = async (path, init) => {
      if (path === `${api}/git/ref/heads/forge`) return branch ? reply({ object: { sha: branch } }) : reply(null, 404);
      if (path === `${api}/git/refs`) {
        creations++;
        expect(init?.body).toEqual({ ref: 'refs/heads/forge', sha: O });
        branch = F;
        return reply({ message: 'Reference already exists' }, 422);
      }
      return fixture.gh(path, init);
    };
    await expect(commitFiles(gh, repo, 'forge', 'main', 'Edit feature', [{ path: 'note.md', replace: [{ old: 'feature original', new: 'edited feature' }] }])).resolves.toMatchObject({ outcome: 'committed', branch: 'forge' });
    expect(fixture.contentRefs).toEqual([F]);
    expect(fixture.commits.get(fixture.live())?.parent).toBe(F);
    expect(fixture.mutations()).toBe(1);
    expect(creations).toBe(1);
  });

  it.each([
    { files: [] }, { status: 'ahead', ahead_by: 1, behind_by: 1, files: [] },
    { status: 'ahead', ahead_by: 0, behind_by: 0, files: [] },
    { status: 'ahead', ahead_by: 1, behind_by: 0 },
    { status: 'ahead', ahead_by: 1, behind_by: 0, files: Array.from({ length: 300 }, (_, i) => ({ filename: `file-${i}.txt` })) }
  ])('requires complete forward comparison evidence before another candidate', async (comparison) => {
    const fixture = race('forward');
    const gh: GitHubRequest = async (path, init) => path.includes('/compare/') ? reply(comparison) : fixture.gh(path, init);
    await expect(commitFiles(gh, repo, 'main', 'main', 'Edit feature', [{ path: 'note.md', replace: [{ old: 'feature original', new: 'edited feature' }] }])).rejects.toMatchObject({ code: 'FORGE_CONFLICT' });
    expect(fixture.live()).toBe(F);
    expect(fixture.mutations()).toBe(1);
  });
});

describe('literal Unicode content', () => {
  it.each(['ASCII', 'café 🎨', '\u0080', '\u0000\u0080', 'café\u0000漢字🎨'])('sends literal UTF-8 text for %j', async (content) => {
    const bodies: unknown[] = [];
    const gh: GitHubRequest = async (path, init) => {
      if (path === api) return reply({ node_id: 'repo' });
      if (path.includes('/git/ref/heads/')) return reply({ object: { sha: O } });
      if (path.includes('/contents/')) return reply(null, 404);
      if (path.endsWith('/git/blobs')) { bodies.push(init!.body); return reply({ sha: 'blob' }, 201); }
      if (path.includes('/git/commits/')) return reply({ tree: { sha: 'base' } });
      if (path.includes('/git/trees/')) return reply({ tree: [], truncated: false });
      if (path.endsWith('/git/trees')) return reply({ sha: 'tree' }, 201);
      if (path.endsWith('/git/commits')) return reply({ sha: D }, 201);
      if (path === '/graphql') return reply({ data: { updateRefs: { clientMutationId: null } } });
      throw new Error(path);
    };
    await commitFiles(gh, repo, 'main', 'main', 'Save text', [{ path: 'note.txt', content }]);
    expect(bodies).toEqual([{ content, encoding: 'utf-8' }]);
    expect([...new TextEncoder().encode((bodies[0] as any).content)]).toEqual([...Buffer.from(content, 'utf8')]);
  });

  it.each<FileWrite>([
    { path: 'note.txt', content: '\uD800' }, { path: 'note.txt', content: '\uDC00' },
    { path: 'note.txt', replace: [{ old: 'ok', new: '\uD800' }] },
    { path: 'note.txt', replace: [{ old: '\uDC00', new: 'ok' }] },
    { path: 'note.ts', edit: { expectedCommit: O, selector: 'note.ts:1-1', replacement: '\uD800' } }
  ])('rejects ill-formed Unicode before GitHub work', async (file) => {
    let calls = 0;
    const gh: GitHubRequest = async () => { calls++; throw new Error('No GitHub calls expected'); };
    await expect(commitFiles(gh, repo, 'main', 'main', 'Save text', [file])).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED', message: expect.stringContaining('Resend well-formed Unicode text') });
    expect(calls).toBe(0);
  });
});
