/**
 * A change is a branch plus its draft pull request, and the chat only ever
 * names it by the intent that created it — "pricing section", never a ref or
 * an id. This file is the one place that turns intent into branch and back,
 * so the model never has to carry an identifier across turns: it says what it
 * means, and every tool result lists the open changes so the next turn can
 * say it again.
 */
import type { Change, GitHubRequest, RepoRef } from './contracts';
import { formatRepo } from './contracts';
import { ForgeError } from './errors';

const BRANCH_PREFIX = 'forge/';
/** One page of open pull requests. See openChanges for why it is not paginated. */
const OPEN_CHANGES_PAGE = 100;

/** Kept well under GitHub's 255-byte ref limit; also keeps names skimmable. */
const MAX_SLUG_LENGTH = 60;

/**
 * Deterministic intent → slug. This is the whole trick that lets a chat name
 * work instead of a ref: the same words always land on the same branch, so
 * "call it whatever you like" is a real instruction rather than a lie.
 *
 * Every character Git refuses in a ref component (space, `~^:?*[\`, control
 * characters, `..`, a leading/trailing `.` or `/`, a trailing `.lock`) is
 * something other than `[a-z0-9]`, so collapsing every run of non-alphanumeric
 * characters to a single hyphen produces a ref-safe slug as a side effect,
 * not as a separate rule to keep in sync with Git's.
 */
function slugify(input: string): string {
  const collapsed = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (collapsed.length <= MAX_SLUG_LENGTH) return collapsed;

  // Prefer cutting at a hyphen near the limit over severing a word mid-way.
  // Only take that hyphen if it's reasonably close to the limit — otherwise
  // a single long word would get chopped down to almost nothing.
  const hardCut = collapsed.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = hardCut.lastIndexOf('-');
  const cut = lastHyphen > MAX_SLUG_LENGTH - 20 ? hardCut.slice(0, lastHyphen) : hardCut;
  return cut.replace(/-+$/, '');
}

/**
 * Intent → branch. Deterministic and one-way in spirit: two different
 * phrasings of the same idea ("pricing section" vs "Pricing Section!!") slug
 * to the same branch on purpose, so a rephrased follow-up continues the same
 * change instead of forking a new one. See `ensureDraftPullRequest`, which is
 * what makes that collision harmless rather than silently overwriting work.
 */
export function changeBranch(intent: string): string {
  const slug = slugify(intent);
  if (slug.length === 0) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message:
        'Say a few words describing the work — e.g. "pricing section" or "fix login redirect" — and that becomes the branch name.'
    });
  }
  return `${BRANCH_PREFIX}${slug}`;
}

/**
 * Branch → display name, for listing open changes back to the chat. This does
 * not need to reconstruct the original intent verbatim (the slugging already
 * threw information away) — it only needs to read as something a human
 * recognises in a list.
 */
export function changeName(branch: string): string {
  const slug = branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : branch;
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
    .filter((pr) => pr.head.ref.startsWith(BRANCH_PREFIX))
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
 * input, so an already-valid branch like "forge/pricing-section" isn't
 * mangled by turning its own slash into a hyphen.
 */
export async function findChange(
  request: GitHubRequest,
  repo: RepoRef,
  nameOrBranch: string
): Promise<Change> {
  const changes = await openChanges(request, repo);
  const wanted = nameOrBranch.trim();
  const wantedWithoutPrefix = wanted.startsWith(BRANCH_PREFIX) ? wanted.slice(BRANCH_PREFIX.length) : wanted;
  const wantedSlug = slugify(wantedWithoutPrefix);

  const matches = changes.filter((change) => {
    const changeSlug = change.branch.slice(BRANCH_PREFIX.length);
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
