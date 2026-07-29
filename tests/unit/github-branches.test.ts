import { describe, expect, it } from 'vitest';
import type { GitHubRequest } from '@forge/git-github';
import { deleteGitHubBranchIfUnchanged, listAllGitHubBranches, listGitHubBranchesWithinBudget, liveWorkspaceBranches, readGitHubBranch } from '../../apps/forge-edge-gateway/src/github-branches';

describe('GitHub branch safety transport', () => {
  it('finds live occupants by repository and branch while excluding terminal workspaces', () => {
    const branches = liveWorkspaceBranches([
      { repository: { owner: 'Acme', name: 'App' }, currentBranch: 'forge/live', state: 'ready' },
      { repository: { owner: 'acme', name: 'app' }, currentBranch: 'forge/done', state: 'destroyed' },
      { repository: { owner: 'acme', name: 'other' }, currentBranch: 'forge/other', state: 'ready' }
    ], 'acme', 'app', ['failed', 'destroyed']);
    expect([...branches]).toEqual(['forge/live']);
  });

  it('paginates until every branch has been read', async () => {
    const calls: string[] = [];
    const request: GitHubRequest = async (path) => {
      calls.push(path);
      const page = Number(new URL(`https://github.invalid${path}`).searchParams.get('page'));
      const count = page <= 2 ? 100 : 5;
      return { status: 200, json: Array.from({ length: count }, (_, index) => ({ name: `p${page}-${index}`, commit: { sha: `${page}-${index}` } })) };
    };
    const branches = await listAllGitHubBranches(request, '/repos/acme/app');
    expect(branches).toHaveLength(205);
    expect(calls).toHaveLength(3);
  });

  it('reports pagination truncation when the shared deadline is exhausted', async () => {
    let calls = 0;
    const request: GitHubRequest = async () => {
      calls += 1;
      return { status: 200, json: [] };
    };
    const result = await listGitHubBranchesWithinBudget(request, '/repos/acme/app', Date.now() - 1);
    expect(result).toEqual({ branches: [], truncated: true });
    expect(calls).toBe(0);
  });

  it('reads slash-containing branch names as one encoded target', async () => {
    let seen = '';
    const request: GitHubRequest = async (path) => {
      seen = path;
      return { status: 200, json: { name: 'forge/task', commit: { sha: 'tip' }, protected: false } };
    };
    const result = await readGitHubBranch(request, '/repos/acme/app', 'forge/task');
    expect(seen).toBe('/repos/acme/app/branches/forge%2Ftask');
    expect(result.branch?.commit.sha).toBe('tip');
  });

  it('refuses deletion when the branch moved and never sends DELETE', async () => {
    const calls: string[] = [];
    const request: GitHubRequest = async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      return { status: 200, json: { name: 'forge/task', commit: { sha: 'new-tip' }, protected: false } };
    };
    const result = await deleteGitHubBranchIfUnchanged(request, '/repos/acme/app', 'forge/task', 'old-tip');
    expect(result).toMatchObject({ outcome: 'refused' });
    expect(calls).toEqual(['GET /repos/acme/app/branches/forge%2Ftask']);
  });

  it('deletes only after the immediate read matches the expected SHA', async () => {
    const calls: string[] = [];
    const request: GitHubRequest = async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (init?.method === 'DELETE') return { status: 204, json: {} };
      return calls.length === 3
        ? { status: 404, json: {} }
        : { status: 200, json: { name: 'forge/task', commit: { sha: 'tip' }, protected: false } };
    };
    const result = await deleteGitHubBranchIfUnchanged(request, '/repos/acme/app', 'forge/task', 'tip');
    expect(result).toEqual({ outcome: 'deleted' });
    expect(calls).toEqual([
      'GET /repos/acme/app/branches/forge%2Ftask',
      'DELETE /repos/acme/app/git/refs/heads/forge/task',
      'GET /repos/acme/app/branches/forge%2Ftask'
    ]);
  });
});
