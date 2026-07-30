import { describe, expect, it } from 'vitest';
import type { GitHubRequest } from '@forge/git-github';
import { GitHubReadUnavailable, githubRepository } from '../../apps/forge-edge-gateway/src/github-repository';

describe('GitHub repository operations', () => {
  it('binds tree and blob reads to one repository-scoped request', async () => {
    const calls: string[] = [];
    const request: GitHubRequest = async (path) => {
      calls.push(path);
      if (path.includes('/git/ref/heads/')) return { status: 200, json: { object: { sha: 'commit' } } };
      if (path.endsWith('/git/commits/commit')) return { status: 200, json: { tree: { sha: 'tree' } } };
      if (path.includes('/git/trees/tree')) {
        return { status: 200, json: { tree: [{ path: 'src/a.ts', type: 'blob', sha: 'blob', size: 4 }] } };
      }
      return { status: 200, json: { content: 'dGVzdA==' } };
    };
    const repository = githubRepository(request, { owner: 'acme', name: 'app' });

    const tree = await repository.readBranchTree('forge/task');
    const file = await repository.readBlob(tree, 'src/a.ts', { maxBytes: 100 });

    expect(file).toMatchObject({ path: 'src/a.ts', content: 'test', blobSha: 'blob' });
    expect(calls).toEqual([
      '/repos/acme/app/git/ref/heads/forge/task',
      '/repos/acme/app/git/commits/commit',
      '/repos/acme/app/git/trees/tree?recursive=1',
      '/repos/acme/app/git/blobs/blob'
    ]);
  });

  it('distinguishes transport failure from a real missing branch response', async () => {
    const request: GitHubRequest = async () => { throw new Error('offline'); };
    await expect(githubRepository(request, '/repos/acme/app').readBranchTree('main'))
      .rejects.toBeInstanceOf(GitHubReadUnavailable);
  });
});
