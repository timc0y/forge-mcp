import { ForgeError } from './errors';
import type { GitHubRequest, RepoRef } from './contracts';
import { formatRepo } from './contracts';

/**
 * Repositories are created by writing to one that does not exist yet. Nothing
 * in the product asks you to make a repo first, for the same reason nothing
 * asks you to name a branch: ceremony is the thing being removed.
 *
 * That makes a typo the one way this rule can hurt you, so the guard below is
 * not optional decoration — it is what keeps "no ceremony" from meaning "no
 * safety net".
 */

/** Levenshtein distance, stopped early once it cannot matter. */
function distanceWithin(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const cost = Math.min(substitution, deletion, insertion);
      current.push(cost);
      if (cost < best) best = cost;
    }
    // Every remaining row can only grow, so a whole row above the limit ends it.
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/**
 * Refuse to create a repository whose name is a near-miss of one that already
 * exists, and name the candidate instead.
 *
 * This is the same rule that ended workspace-id ambiguity in the old system
 * (`bd8d130`): when the machine cannot tell which of two things you meant, it
 * must say both names rather than pick. Here the cost of picking wrong is an
 * orphan repository and edits that land somewhere nobody looks.
 */
export function assertNotNearExisting(name: string, existing: string[]): void {
  const candidate = name.trim().toLowerCase();
  const near = existing.filter((other) => {
    const known = other.toLowerCase();
    if (known === candidate) return true;
    // Two edits catches transposition, a dropped character and a wrong one.
    // Three starts matching genuinely different short names.
    return distanceWithin(candidate, known, 2) <= 2;
  });

  if (near.length === 0) return;

  throw new ForgeError({
    code: 'FORGE_AMBIGUOUS',
    message:
      `"${name}" is within a character or two of ${near.map((value) => `"${value}"`).join(', ')}. ` +
      'Write to that repository if you meant it, or choose a name that is clearly different.',
    retryable: false,
    details: { requested: name, candidates: near }
  });
}

/**
 * Create a repository on the authenticated user's account.
 *
 * Needs a user token, not an installation token: an installation cannot create
 * a repository on someone's account. Access afterwards needs no grant of ours —
 * GitHub gives an App access to repositories the App itself creates, even when
 * it was installed against selected repositories only. That documented
 * behaviour is why "create and self-authorize" costs nothing here.
 *
 * `auto_init` is load-bearing. GitHub answers 409 to every ref read in a
 * repository with no commits, so an empty repository can never receive its
 * first write through the ordinary commit path. One flag removes the entire
 * parentless-commit special case.
 */
export async function createRepo(
  userRequest: GitHubRequest,
  name: string,
  options: { private: boolean; description?: string }
): Promise<RepoRef> {
  const response = await userRequest('/user/repos', {
    method: 'POST',
    body: {
      name,
      private: options.private,
      auto_init: true,
      ...(options.description ? { description: options.description } : {})
    }
  });

  if (response.status === 422) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message:
        `GitHub refused to create "${name}". It usually already exists on this account, ` +
        'or the name uses characters GitHub does not allow.',
      retryable: false
    });
  }

  if (response.status !== 201) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `GitHub did not create "${name}" (status ${response.status}).`,
      retryable: response.status >= 500
    });
  }

  const body = response.json as { owner?: { login?: string }; name?: string } | null;
  const owner = body?.owner?.login;
  const created = body?.name;
  if (!owner || !created) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: 'GitHub created the repository but did not return its owner and name.',
      retryable: true
    });
  }

  return { owner, name: created };
}

/**
 * The default branch, which is the base of every change and the only branch a
 * merge may move.
 */
export async function defaultBranch(request: GitHubRequest, repo: RepoRef): Promise<string> {
  const response = await request(`/repos/${repo.owner}/${repo.name}`);
  if (response.status === 404) {
    throw new ForgeError({
      code: 'FORGE_NOT_FOUND',
      message: `${formatRepo(repo)} is not a repository Forge can reach.`,
      retryable: false
    });
  }
  if (response.status !== 200) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `GitHub did not return ${formatRepo(repo)} (status ${response.status}).`,
      retryable: response.status >= 500
    });
  }

  const branch = (response.json as { default_branch?: string } | null)?.default_branch?.trim();
  if (!branch) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `GitHub did not name a default branch for ${formatRepo(repo)}.`,
      retryable: true
    });
  }
  return branch;
}
