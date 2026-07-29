import type { GitHubRequest } from '@forge/git-github';

export interface GitHubBranch {
  name: string;
  commit: { sha: string };
  protected?: boolean;
}

export function liveWorkspaceBranches(
  occupants: Array<{ repository: { owner: string; name: string } | null; currentBranch: string | null; state: string | null }>,
  owner: string,
  repo: string,
  terminalStates: readonly string[]
): Set<string> {
  return new Set(
    occupants
      .filter((occupant) =>
        occupant.repository?.owner.toLowerCase() === owner.toLowerCase() &&
        occupant.repository.name.toLowerCase() === repo.toLowerCase() &&
        occupant.currentBranch !== null &&
        occupant.state !== null &&
        !terminalStates.includes(occupant.state)
      )
      .map((occupant) => occupant.currentBranch as string)
  );
}

function encodedBranch(branch: string): string {
  return encodeURIComponent(branch);
}

/** List the complete branch collection, rather than silently stopping at 100. */
export async function listAllGitHubBranches(request: GitHubRequest, base: string): Promise<GitHubBranch[]> {
  return (await listGitHubBranchesWithinBudget(request, base)).branches;
}

export async function listGitHubBranchesWithinBudget(
  request: GitHubRequest,
  base: string,
  deadlineAt = Number.POSITIVE_INFINITY
): Promise<{ branches: GitHubBranch[]; truncated: boolean }> {
  const branches: GitHubBranch[] = [];
  for (let page = 1; ; page += 1) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return { branches, truncated: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = Number.isFinite(deadlineAt)
      ? await Promise.race([
          request(`${base}/branches?per_page=100&page=${page}`),
          new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), remaining); })
        ]).finally(() => { if (timer) clearTimeout(timer); })
      : await request(`${base}/branches?per_page=100&page=${page}`);
    if (!response) return { branches, truncated: true };
    if (response.status !== 200) throw new Error(`GitHub branch list failed with HTTP ${response.status} on page ${page}.`);
    const values = response.json as GitHubBranch[];
    branches.push(...values);
    if (values.length < 100) return { branches, truncated: false };
  }
}

/** Re-read the deletion target immediately before mutation. */
export async function readGitHubBranch(
  request: GitHubRequest,
  base: string,
  branch: string
): Promise<{ status: number; branch?: GitHubBranch }> {
  const response = await request(`${base}/branches/${encodedBranch(branch)}`);
  return response.status === 200
    ? { status: 200, branch: response.json as GitHubBranch }
    : { status: response.status };
}

export type BranchDeleteResult =
  | { outcome: 'deleted' }
  | { outcome: 'already_absent' }
  | { outcome: 'refused'; reason: string };

/** Best available REST guard: re-read the live tip immediately before deletion. */
export async function deleteGitHubBranchIfUnchanged(
  request: GitHubRequest,
  base: string,
  branch: string,
  expectedSha: string
): Promise<BranchDeleteResult> {
  const fresh = await readGitHubBranch(request, base, branch);
  if (fresh.status === 404) return { outcome: 'already_absent' };
  if (fresh.status !== 200 || !fresh.branch) {
    return { outcome: 'refused', reason: `GitHub returned HTTP ${fresh.status} re-reading the branch immediately before deletion.` };
  }
  if (fresh.branch.protected === true) {
    return { outcome: 'refused', reason: `${branch} is protected on GitHub.` };
  }
  if (fresh.branch.commit.sha !== expectedSha) {
    return {
      outcome: 'refused',
      reason: `${branch} moved from ${expectedSha} to ${fresh.branch.commit.sha}; deletion refused. List again and reassess the new tip.`
    };
  }
  const removed = await request(`${base}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
  return removed.status === 204
    ? { outcome: 'deleted' }
    : { outcome: 'refused', reason: `GitHub returned HTTP ${removed.status}.` };
}
