import { expect, it } from 'vitest';
import { commitFiles } from '../src/write';
import { openChanges } from '../src/change';
import type { GitHubRequest } from '../src/contracts';
const reply = (json: unknown, status = 200) => ({ json, status, text: '', headers: new Headers() });
const repo = { owner: 'o', name: 'r' };

it('continues proposal discovery beyond a full raw page and ignores forks', async () => {
  const pr = (number: number, ref: string, repository = 'o/r') => ({ number, head: { ref, repo: { full_name: repository } }, title: ref });
  const gh: GitHubRequest = async (path) => reply(path.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => pr(i, i === 1 ? 'forge' : `other-${i}`, 'outsider/fork')) : [pr(101, 'forge/older')]);
  expect(await openChanges(gh, repo)).toMatchObject([{ number: 101, branch: 'forge/older' }]);
});
it('refuses to infer proposal absence beyond its discovery bound', async () => {
  const gh: GitHubRequest = async () => reply(Array.from({ length: 100 }, (_, i) => ({ number: i, head: { ref: 'other', repo: { full_name: 'o/r' } } })));
  await expect(openChanges(gh, repo)).rejects.toMatchObject({ code: 'FORGE_UPSTREAM_UNAVAILABLE' });
});

function writeFixture(mode: string, rename = false) {
  let refs = 0;
  let patches = 0;
  const trees: Array<{ base_tree: string; tree: Array<{ mode: string; path: string }> }> = [];
  const gh: GitHubRequest = async (path, init) => {
    if (path.includes('/git/ref/heads/')) return reply({ object: { sha: ++refs === 1 ? 'a' : 'b' } });
    if (path.includes('/contents/')) return reply({ type: 'file', size: 6, content: btoa('before'), encoding: 'base64' });
    if (path.endsWith('/git/blobs')) return reply({ sha: 'blob' }, 201);
    if (path.includes('/git/commits/')) return reply({ tree: { sha: path.endsWith('/a') ? 'ta' : 'tb' } });
    if (path.includes('/git/trees/')) return reply({ tree: [{ path: 'old.md', mode, type: 'blob', sha: 'oldblob' }], truncated: false });
    if (path.endsWith('/git/trees')) { trees.push(init!.body as typeof trees[number]); return reply({ sha: 't' + trees.length }, 201); }
    if (path.endsWith('/git/commits')) return reply({ sha: 'c' + trees.length }, 201);
    if (path === '/repos/o/r') return reply({ node_id: 'repo-id' });
    if (path === '/graphql') return rename && ++patches === 1 ? reply({ data: { updateRefs: null }, errors: [{ type: 'UNPROCESSABLE', path: ['updateRefs'] }] }) : reply({ data: { updateRefs: { clientMutationId: null } } });
    if (path.includes('/compare/')) return reply({ status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: 'new.md', previous_filename: 'old.md', status: 'renamed' }] });
    throw Error('Unexpected fixture request: ' + path);
  };
  return { gh, trees };
}
it('preserves the executable mode on an ordinary edit', async () => {
  const fixture = writeFixture('100755');
  await commitFiles(fixture.gh, repo, 'main', 'main', 'edit', [{ path: 'old.md', replace: [{ old: 'before', new: 'after' }] }]);
  expect(fixture.trees[0]?.tree[0]?.mode).toBe('100755');
});
it('refuses to resurrect a concurrently renamed path', async () => {
  const fixture = writeFixture('100644', true);
  await expect(commitFiles(fixture.gh, repo, 'main', 'main', 'edit', [{ path: 'old.md', replace: [{ old: 'before', new: 'after' }] }])).rejects.toMatchObject({ code: 'FORGE_CONFLICT' });
  expect(fixture.trees).toHaveLength(1);
});
it('refuses to turn a symlink into a regular file', async () => {
  const fixture = writeFixture('120000');
  await expect(commitFiles(fixture.gh, repo, 'main', 'main', 'edit', [{ path: 'old.md', content: 'after' }])).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
  expect(fixture.trees).toHaveLength(0);
});
