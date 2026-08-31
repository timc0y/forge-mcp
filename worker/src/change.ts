/**
 * A change is Forge's one fixed branch plus its draft pull request. The branch
 * name carries no user state: it only says that Forge made the proposal.
 */
import type { Change, GitHubRequest, RepoRef } from './contracts';
import { formatRepo } from './contracts';
import { ForgeError } from './errors';

export const CHANGE_BRANCH = 'forge';
const LEGACY_BRANCH_PREFIX = 'forge/';
/** One page of open pull requests. See openChanges for why it is not paginated. */
const OPEN_CHANGES_PAGE = 100;

export function changeName(branch: string): string {
  const slug = branch.startsWith(LEGACY_BRANCH_PREFIX) ? branch.slice(LEGACY_BRANCH_PREFIX.length) : branch;
  return slug.replace(/-+/g, ' ').trim();
}

/** The subset of GitHub's pull-request JSON this module actually reads. */
interface PullRequestPayload {
  number: number;
  head: { ref: string };
  draft: boolean;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toPullRequestPayload(value: unknown): PullRequestPayload | null {
  if (!isRecord(value)) return null;
  const { number, head, draft, updated_at: updatedAt } = value;
  if (typeof number !== 'number' || !isRecord(head)) return null;
  const ref = head.ref;
  if (typeof ref !== 'string') return null;
  return {
    number,
    head: { ref },
    draft: draft === true,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : ''
  };
}

function parsePullRequests(json: unknown): PullRequestPayload[] {
  if (!Array.isArray(json)) return [];
  return json.map(toPullRequestPayload).filter((pr): pr is PullRequestPayload => pr !== null);
}

/**
 * Lists open changes for a repo. This runs on every tool result (it's how a
 * summarised chat recovers what it was doing without remembering an id), so
 * it has to stay a single call. GitHub's "list pull requests" endpoint carries
 * no diff stats — only "get a single pull request" does — so `stats` is left
 * absent rather than costing one extra request per change on every turn.
 * Absent means unmeasured; it must never be reported as zero, because a human
 * reading "0 files changed" would believe it.
 */
export async function openChanges(request: GitHubRequest, repo: RepoRef): Promise<Change[]> {
  const response = await request(
    `/repos/${repo.owner}/${repo.name}/pulls?state=open&sort=created&direction=desc&per_page=${OPEN_CHANGES_PAGE}`
  );

  if (response.status !== 200) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `Could not list open changes for ${formatRepo(repo)} (HTTP ${response.status}).`,
      retryable: true
    });
  }

  // One page, deliberately: this runs on every tool result and paginating it
  // would put an unbounded number of requests on the hot path. Past 100 open
  // changes the list is incomplete, and `openChangesTruncated` is how a caller
  // learns that rather than quietly seeing fewer names than exist.
  return parsePullRequests(response.json)
    .filter((pr) => pr.head.ref === CHANGE_BRANCH || pr.head.ref.startsWith(LEGACY_BRANCH_PREFIX))
    .map((pr) => ({
      name: changeName(pr.head.ref),
      branch: pr.head.ref,
      number: pr.number,
      draft: pr.draft,
      updatedAt: pr.updatedAt
    }));
}

/** True when the open-changes list above may be missing entries. */
export function openChangesTruncated(changes: Change[]): boolean {
  return changes.length >= OPEN_CHANGES_PAGE;
}

/**
 * Resolves whatever the model said back onto an open change: the exact
 * branch, the display name, or the slug of what was passed — because after a
 * long chat is summarised, what survives is words like "the pricing one", not
 * a branch string. Raw branch and name are checked before slugifying the
 * input. This also keeps old `forge/name` changes available for approval.
 */
export async function findChange(
  request: GitHubRequest,
  repo: RepoRef,
  nameOrBranch: string
): Promise<Change> {
  const changes = await openChanges(request, repo);
  const wanted = nameOrBranch.trim();
  const wantedWithoutPrefix = wanted.startsWith(LEGACY_BRANCH_PREFIX) ? wanted.slice(LEGACY_BRANCH_PREFIX.length) : wanted;
  const wantedSlug = wantedWithoutPrefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const matches = changes.filter((change) => {
    const changeSlug = changeName(change.branch).replace(/[^a-z0-9]+/g, '-');
    return (
      change.branch === wanted ||
      change.name.toLowerCase() === wanted.toLowerCase() ||
      (wantedSlug.length > 0 && changeSlug === wantedSlug)
    );
  });

  if (matches.length === 1) {
    const only = matches[0];
    if (only !== undefined) return only;
  }

  if (matches.length === 0) {
    // A summarised conversation only recovers if the error itself names the
    // real candidates — never a bare "not found".
    const candidates = changes.map((change) => `"${change.name}"`).join(', ');
    throw new ForgeError({
      code: 'FORGE_NOT_FOUND',
      message:
        changes.length === 0
          ? `There are no open changes in ${formatRepo(repo)} yet.`
          : `No open change matches "${nameOrBranch}" in ${formatRepo(repo)}. Open changes: ${candidates}.`,
      details: { candidates: changes.map((change) => change.name) }
    });
  }

  const candidates = matches.map((change) => `"${change.name}"`).join(', ');
  throw new ForgeError({
    code: 'FORGE_AMBIGUOUS',
    message: `"${nameOrBranch}" matches more than one open change in ${formatRepo(repo)}: ${candidates}. Say which one.`,
    details: { candidates: matches.map((change) => change.name) }
  });
}

/** Looks up an already-open PR for a branch without creating anything. */
async function findOpenPullRequestForBranch(
  request: GitHubRequest,
  repo: RepoRef,
  branch: string
): Promise<number | null> {
  const response = await request(
    `/repos/${repo.owner}/${repo.name}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${branch}`)}&per_page=1`
  );
  // A failed lookup here isn't fatal on its own — the create attempt below
  // will surface GitHub's real error if this genuinely can't be resolved.
  if (response.status !== 200) return null;
  const [first] = parsePullRequests(response.json);
  return first?.number ?? null;
}

/**
 * Opens a draft pull request for `branch` if none is open yet, and returns
 * its number either way. Checking first — rather than creating and handling
 * "already exists" — is what makes calling this twice for the same change
 * safe: GitHub has no upsert for pull requests, so the idempotency has to
 * live here.
 */
export async function ensureDraftPullRequest(
  request: GitHubRequest,
  repo: RepoRef,
  branch: string,
  intent: string,
  baseBranch: string
): Promise<number> {
  const existing = await findOpenPullRequestForBranch(request, repo, branch);
  if (existing !== null) return existing;

  const response = await request(`/repos/${repo.owner}/${repo.name}/pulls`, {
    method: 'POST',
    body: { title: intent, head: branch, base: baseBranch, draft: true }
  });

  if (response.status === 201) {
    const created = toPullRequestPayload(response.json);
    if (created !== null) return created.number;
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `GitHub opened a pull request for "${changeName(branch)}" but returned an unreadable response.`,
      retryable: true
    });
  }

  if (response.status === 422) {
    // Two distinct causes both 422 here: a branch with no commits ahead of
    // base (GitHub: "No commits between base and head"), and a race where
    // another call opened the PR between the check above and this request.
    // Re-querying rather than assuming keeps the race case idempotent too.
    const raced = await findOpenPullRequestForBranch(request, repo, branch);
    if (raced !== null) return raced;
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `Can't open a pull request for "${changeName(branch)}" yet — ${branch} has no commits ahead of ${baseBranch}. Write a file on this change first.`,
      details: { branch, baseBranch }
    });
  }

  throw new ForgeError({
    code: 'FORGE_UPSTREAM_UNAVAILABLE',
    message: `GitHub refused to open a pull request for "${changeName(branch)}" (HTTP ${response.status}).`,
    retryable: true
  });
}
