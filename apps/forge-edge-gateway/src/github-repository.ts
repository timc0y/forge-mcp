import { ForgeError, type RepositoryRef } from '@forge/core';
import type { GitHubRequest } from '@forge/git-github';
import { normalizeRepoPath } from './repo-paths';

interface GitHubBranch {
  name: string;
  commit: { sha: string };
  protected?: boolean;
}

interface GitHubContentBlob {
  content?: string;
  sha?: string;
  encoding?: string;
}

interface PullRequestBody {
  number: number;
  title: string;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
  merged?: boolean;
  state: string;
  mergeable: boolean | null;
  mergeable_state?: string;
  merge_commit_sha?: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
}

export interface GitHubTreeEntry {
  path: string;
  sha: string;
  type: 'blob' | 'tree' | 'commit';
  mode?: string;
  size?: number;
}

export interface GitHubBranchTree {
  commitSha: string;
  treeSha: string;
  /** GitHub omitted entries because its recursive-tree response exceeded its own size limit. */
  truncated: boolean;
  entries: GitHubTreeEntry[];
  byPath: Map<string, GitHubTreeEntry>;
}

export interface GitHubReadOptions {
  startLine?: number;
  endLine?: number;
  maxBytes: number;
}

export interface GitHubReadResult {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  blobSha: string;
}

export interface GitHubListEntry {
  path: string;
  /** Basename or path relative to the listing root; `path` is always repo-relative. */
  name?: string;
  type: 'file' | 'directory' | 'symlink';
  sizeBytes?: number;
}

type BranchDeleteResult =
  | { outcome: 'deleted' }
  | { outcome: 'already_absent' }
  | { outcome: 'refused'; reason: string };

type FragmentSourceResult =
  | { ok: true; body: GitHubContentBlob; sourceRef: string; branchMissing: boolean }
  | { ok: false; kind: 'file_missing'; sourceRef: string; branchMissing: boolean }
  | { ok: false; kind: 'base_unavailable'; branchMissing: true }
  | { ok: false; kind: 'provider'; status: number; operation: 'content' | 'ref'; sourceRef: string };

export interface PullRequestReadiness {
  number: number;
  title: string;
  body: string;
  url: string;
  draft: boolean;
  head_ref: string;
  base_ref: string;
  head_sha: string;
  mergeable: boolean | null;
  mergeable_state: string;
  state: string;
  already_merged: boolean;
  merge_commit_sha: string | null;
  checks: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    failing: string[];
  };
  review_decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'NOT_REQUIRED' | 'UNKNOWN';
  safe_to_merge: boolean;
  blockers: string[];
}

/**
 * A draft is the one intentional exception to the initial merge verdict: an
 * approved forge_merge may make it ready immediately before merging. GitHub
 * reports that transition as draft/null/false, but all check, review, branch
 * protection, and non-draft merge blockers must still stop the queue.
 */
export function deferredMergeQueueBlockers(
  readiness: Pick<PullRequestReadiness, 'draft' | 'blockers'>
): string[] {
  if (!readiness.draft) return [...readiness.blockers];
  return readiness.blockers.filter((blocker) =>
    blocker !== 'Still a draft.' &&
    blocker !== 'GitHub mergeable state is draft, not clean.' &&
    !/^GitHub mergeable verdict is (?:null|false)\.$/u.test(blocker)
  );
}

/** A network or transient provider failure, never a real missing branch/file answer. */
export class GitHubReadUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubReadUnavailable';
  }
}

type RepositoryCoordinates = Pick<RepositoryRef, 'owner' | 'name'>;

function repositoryBase(repository: RepositoryCoordinates | string): string {
  return typeof repository === 'string'
    ? repository.replace(/\/+$/u, '')
    : `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function encodedGitRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function encodedContentPath(path: string): string {
  return normalizeRepoPath(path).split('/').map(encodeURIComponent).join('/');
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/\n/gu, '');
  return Uint8Array.from(atob(clean), (character) => character.charCodeAt(0));
}

function truncateUtf8(value: string, limit: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= limit) return { value, truncated: false };
  return { value: new TextDecoder().decode(bytes.slice(0, limit)), truncated: true };
}

type PageResult<T> = { values: T[]; truncated: boolean; error?: string; errorPage?: number };

/**
 * Repository-scoped GitHub operations behind the existing authenticated
 * GitHubRequest seam. Callers provide the repository once; this module owns
 * GitHub's ref/path encoding, pagination, status interpretation and guarded
 * mutations.
 */
class GitHubRepositoryOperations {
  private readonly base: string;

  constructor(
    private readonly request: GitHubRequest,
    repository: RepositoryCoordinates | string
  ) {
    this.base = repositoryBase(repository);
  }

  private async call(path: string, what?: string): Promise<{ status: number; json: unknown }> {
    try {
      return await this.request(`${this.base}${path}`);
    } catch (error) {
      if (!what) throw error;
      throw new GitHubReadUnavailable(
        `GitHub was unreachable while ${what}: ${error instanceof Error ? error.message : 'network error'}.`
      );
    }
  }

  private async paginate<T>(
    path: string,
    valuesFrom: (json: unknown) => T[],
    deadlineAt = Number.POSITIVE_INFINITY
  ): Promise<PageResult<T>> {
    const values: T[] = [];
    for (let page = 1; ; page += 1) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return { values, truncated: true };
      const separator = path.includes('?') ? '&' : '?';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = Number.isFinite(deadlineAt)
        ? await Promise.race([
            this.call(`${path}${separator}per_page=100&page=${page}`),
            new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), remaining); })
          ]).finally(() => { if (timer) clearTimeout(timer); })
        : await this.call(`${path}${separator}per_page=100&page=${page}`);
      if (!response) return { values, truncated: true };
      if (response.status !== 200) {
        return { values, truncated: false, error: `HTTP ${response.status}`, errorPage: page };
      }
      const pageValues = valuesFrom(response.json);
      values.push(...pageValues);
      if (pageValues.length < 100) return { values, truncated: false };
    }
  }

  async readBranchTree(branch: string): Promise<GitHubBranchTree> {
    const refResponse = await this.call(`/git/ref/heads/${encodedGitRef(branch)}`, `reading the tip of ${branch}`);
    if (refResponse.status === 404) {
      const { owner, repo } = this.repositoryDetails();
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_GIT_STATE_DIVERGED',
        message: `GitHub has no branch named ${branch} on ${owner}/${repo}, but this workspace is recorded as editing it. Call forge_workspace_get to see the branch Forge actually has, or forge_start to cut ${branch} on GitHub before reading from it.`,
        retryable: false,
        details: { owner, repo, branch }
      });
    }
    if (isTransientStatus(refResponse.status)) {
      throw new GitHubReadUnavailable(`GitHub returned HTTP ${refResponse.status} reading the tip of ${branch}.`);
    }
    if (refResponse.status !== 200) {
      const { owner, repo } = this.repositoryDetails();
      throw new ForgeError({
        code: 'FORGE_PERMISSION_DENIED',
        message: `GitHub returned HTTP ${refResponse.status} reading the tip of ${branch} on ${owner}/${repo}. Call forge_access for this repository to see whether Forge still has permission, then retry.`,
        retryable: false,
        details: { owner, repo, branch, status: refResponse.status }
      });
    }
    const commitSha = (refResponse.json as { object: { sha: string } }).object.sha;

    const commitResponse = await this.call(`/git/commits/${commitSha}`, `reading commit ${commitSha}`);
    if (isTransientStatus(commitResponse.status)) {
      throw new GitHubReadUnavailable(`GitHub returned HTTP ${commitResponse.status} reading commit ${commitSha}.`);
    }
    if (commitResponse.status !== 200) {
      const { owner, repo } = this.repositoryDetails();
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: `GitHub returned HTTP ${commitResponse.status} reading the commit at the tip of ${branch}. Retry the read; if it keeps failing, call forge_access for this repository.`,
        retryable: true,
        details: { owner, repo, branch, commitSha, status: commitResponse.status }
      });
    }
    const treeSha = (commitResponse.json as { tree: { sha: string } }).tree.sha;

    const treeResponse = await this.call(`/git/trees/${treeSha}?recursive=1`, `reading the tree at ${treeSha}`);
    if (isTransientStatus(treeResponse.status)) {
      throw new GitHubReadUnavailable(`GitHub returned HTTP ${treeResponse.status} reading the file tree at ${treeSha}.`);
    }
    if (treeResponse.status !== 200) {
      const { owner, repo } = this.repositoryDetails();
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: `GitHub returned HTTP ${treeResponse.status} reading the file tree at the tip of ${branch}. Retry the read; if it keeps failing, call forge_access for this repository.`,
        retryable: true,
        details: { owner, repo, branch, treeSha, status: treeResponse.status }
      });
    }
    const body = treeResponse.json as { tree?: GitHubTreeEntry[]; truncated?: boolean };
    const entries = (body.tree ?? []).filter((entry) => entry.type === 'blob' || entry.type === 'tree');
    return {
      commitSha,
      treeSha,
      truncated: body.truncated === true,
      entries,
      byPath: new Map(entries.map((entry) => [entry.path, entry]))
    };
  }

  async readBlob(tree: GitHubBranchTree, path: string, options: GitHubReadOptions): Promise<GitHubReadResult> {
    const entry = tree.byPath.get(path);
    if (!entry || entry.type !== 'blob') {
      throw new ForgeError({
        code: 'FORGE_FILE_NOT_FOUND',
        message: `${path} does not exist on the branch Forge just read from GitHub. List the directory with forge_files_list to see what is actually there, or write it with forge_edit to create it.`,
        retryable: false,
        details: { path }
      });
    }
    const response = await this.call(`/git/blobs/${entry.sha}`, `reading the blob for ${path}`);
    if (isTransientStatus(response.status)) {
      throw new GitHubReadUnavailable(`GitHub returned HTTP ${response.status} reading the blob for ${path}.`);
    }
    if (response.status !== 200) {
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: `GitHub returned HTTP ${response.status} reading ${path}. Retry the read; if it keeps failing, call forge_access for this repository.`,
        retryable: true,
        details: { path, status: response.status }
      });
    }
    const body = response.json as { content?: string };
    if (typeof body.content !== 'string') {
      throw new ForgeError({
        code: 'FORGE_PROVIDER_UNAVAILABLE',
        message: `GitHub returned no content for ${path}. Retry the read; if it keeps failing, report this rather than assuming the file is empty.`,
        retryable: true,
        details: { path }
      });
    }
    const fullText = new TextDecoder().decode(decodeBase64(body.content));
    const lines = fullText.split('\n');
    const selected = options.startLine !== undefined || options.endLine !== undefined
      ? lines.slice(Math.max(0, (options.startLine ?? 1) - 1), options.endLine).join('\n')
      : fullText;
    const limited = truncateUtf8(selected, options.maxBytes);
    return {
      path,
      content: limited.value,
      sizeBytes: new TextEncoder().encode(limited.value).byteLength,
      truncated: limited.truncated,
      blobSha: entry.sha
    };
  }

  async listBranches(deadlineAt = Number.POSITIVE_INFINITY): Promise<{ branches: GitHubBranch[]; truncated: boolean }> {
    const result = await this.paginate<GitHubBranch>('/branches', (json) => json as GitHubBranch[], deadlineAt);
    if (result.error) {
      throw new Error(`GitHub branch list failed with ${result.error} on page ${result.errorPage}.`);
    }
    return { branches: result.values, truncated: result.truncated };
  }

  async readBranch(branch: string): Promise<{ status: number; branch?: GitHubBranch }> {
    const response = await this.call(`/branches/${encodeURIComponent(branch)}`);
    return response.status === 200
      ? { status: 200, branch: response.json as GitHubBranch }
      : { status: response.status };
  }

  async deleteBranchIfUnchanged(branch: string, expectedSha: string): Promise<BranchDeleteResult> {
    const fresh = await this.readBranch(branch);
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
    const removed = await this.request(`${this.base}/git/refs/heads/${encodedGitRef(branch)}`, { method: 'DELETE' });
    if (removed.status !== 204) {
      return { outcome: 'refused', reason: `GitHub returned HTTP ${removed.status}.` };
    }
    const readBack = await this.readBranch(branch);
    return readBack.status === 404
      ? { outcome: 'deleted' }
      : { outcome: 'refused', reason: `GitHub accepted deletion, but the branch read-back returned HTTP ${readBack.status}; Forge will not claim it is gone.` };
  }

  async readFragmentSource(input: { branch: string; baseSha?: string; path: string }): Promise<FragmentSourceResult> {
    const contentPath = `/contents/${encodedContentPath(input.path)}`;
    const branchRead = await this.call(`${contentPath}?ref=${encodeURIComponent(input.branch)}`);
    if (branchRead.status === 200) {
      return { ok: true, body: branchRead.json as GitHubContentBlob, sourceRef: input.branch, branchMissing: false };
    }
    if (branchRead.status !== 404) {
      return { ok: false, kind: 'provider', status: branchRead.status, operation: 'content', sourceRef: input.branch };
    }

    const refRead = await this.call(`/git/ref/heads/${encodedGitRef(input.branch)}`);
    if (refRead.status === 200) {
      return { ok: false, kind: 'file_missing', sourceRef: input.branch, branchMissing: false };
    }
    if (refRead.status !== 404) {
      return { ok: false, kind: 'provider', status: refRead.status, operation: 'ref', sourceRef: input.branch };
    }
    if (!input.baseSha) return { ok: false, kind: 'base_unavailable', branchMissing: true };

    const baseRead = await this.call(`${contentPath}?ref=${encodeURIComponent(input.baseSha)}`);
    if (baseRead.status === 200) {
      return { ok: true, body: baseRead.json as GitHubContentBlob, sourceRef: input.baseSha, branchMissing: true };
    }
    if (baseRead.status === 404) {
      return { ok: false, kind: 'file_missing', sourceRef: input.baseSha, branchMissing: true };
    }
    return { ok: false, kind: 'provider', status: baseRead.status, operation: 'content', sourceRef: input.baseSha };
  }

  async readPullRequestReadiness(number: number): Promise<PullRequestReadiness> {
    const pr = await this.call(`/pulls/${number}`);
    if (pr.status !== 200) {
      const permanent = pr.status === 401 || pr.status === 403 || pr.status === 404 || (pr.status >= 400 && pr.status < 500 && pr.status !== 429);
      throw new ForgeError({
        code: pr.status === 401 || pr.status === 403
          ? 'FORGE_PERMISSION_DENIED'
          : pr.status === 404
            ? 'FORGE_FILE_NOT_FOUND'
            : permanent
              ? 'FORGE_VALIDATION_FAILED'
              : 'FORGE_PROVIDER_UNAVAILABLE',
        message: pr.status === 404
          ? `Pull request #${number} was not found on GitHub. Check the repository and pull-request number, then retry forge_merge.`
          : pr.status === 401 || pr.status === 403
            ? `GitHub denied access while reading pull request #${number}. Reconnect Forge or authorize this repository, then retry forge_merge.`
            : `GitHub returned HTTP ${pr.status} while reading pull request #${number}. ${permanent ? 'Check the pull-request address and arguments, then retry forge_merge.' : 'Retry forge_merge after GitHub recovers.'}`,
        retryable: !permanent,
        details: { pull_request: number, status: pr.status }
      });
    }
    const body = pr.json as PullRequestBody;
    const blockers: string[] = [];
    const array = <T>(json: unknown): T[] => Array.isArray(json) ? json as T[] : [];

    const runsResult = await this.paginate<{ name: string; status: string; conclusion: string | null }>(
      `/commits/${body.head.sha}/check-runs`,
      (json) => Array.isArray(json)
        ? json as Array<{ name: string; status: string; conclusion: string | null }>
        : (json as { check_runs?: Array<{ name: string; status: string; conclusion: string | null }> }).check_runs ?? []
    );
    if (runsResult.error) blockers.push(`Check-run evidence unavailable (${runsResult.error}).`);

    const statusesResult = await this.paginate<{ context: string; state: string }>(
      `/commits/${body.head.sha}/statuses`,
      array
    );
    const latestStatusByContext = new Map<string, { context: string; state: string }>();
    for (const status of statusesResult.values) {
      if (!latestStatusByContext.has(status.context)) latestStatusByContext.set(status.context, status);
    }
    const statuses = [...latestStatusByContext.values()];
    if (statusesResult.error) blockers.push(`Classic status evidence unavailable (${statusesResult.error}).`);

    const reviewsResult = await this.paginate<{
      state: string;
      submitted_at?: string;
      user?: { login?: string };
    }>(`/pulls/${number}/reviews`, array);
    if (reviewsResult.error) blockers.push(`Review evidence unavailable (${reviewsResult.error}).`);

    const baseBranch = await this.readBranch(body.base.ref);
    let requiredApprovals: number | undefined;
    let requiredContexts: string[] | undefined;
    if (baseBranch.status !== 200) {
      blockers.push(`Base-branch protection evidence unavailable (HTTP ${baseBranch.status}).`);
    } else if (baseBranch.branch?.protected !== true) {
      requiredApprovals = 0;
      requiredContexts = [];
    } else {
      const protection = await this.call(`/branches/${encodeURIComponent(body.base.ref)}/protection`);
      if (protection.status !== 200) {
        blockers.push(`Required-review evidence unavailable (HTTP ${protection.status}).`);
      } else {
        const rules = protection.json as {
          required_pull_request_reviews?: { required_approving_review_count?: number } | null;
          required_status_checks?: {
            contexts?: string[];
            checks?: Array<{ context?: string }>;
          } | null;
        };
        requiredApprovals = Math.max(0, rules.required_pull_request_reviews?.required_approving_review_count ?? 0);
        requiredContexts = [
          ...(rules.required_status_checks?.contexts ?? []),
          ...(rules.required_status_checks?.checks ?? []).flatMap((check) => check.context ? [check.context] : [])
        ].filter((context, index, all) => all.indexOf(context) === index);
      }
    }

    const successfulConclusions = new Set(['success', 'neutral', 'skipped']);
    const failedRuns = runsResult.values.filter(
      (run) => run.status === 'completed' && run.conclusion !== null && !successfulConclusions.has(run.conclusion)
    );
    const pendingRuns = runsResult.values.filter((run) => run.status !== 'completed');
    const passedRuns = runsResult.values.filter(
      (run) => run.status === 'completed' && successfulConclusions.has(run.conclusion ?? '')
    );
    const failedStatuses = statuses.filter((status) => status.state === 'failure' || status.state === 'error');
    const pendingStatuses = statuses.filter((status) => status.state === 'pending');
    const passedStatuses = statuses.filter((status) => status.state === 'success');
    const failing = [...failedRuns.map((run) => run.name), ...failedStatuses.map((status) => status.context)];
    if (failing.length) blockers.push(`${failing.length} check/status context(s) failing: ${failing.join(', ')}.`);
    const pending = pendingRuns.length + pendingStatuses.length;
    if (pending) blockers.push(`${pending} check/status context(s) still pending.`);

    if (requiredContexts) {
      const successfulContexts = new Set([
        ...passedRuns.map((run) => run.name),
        ...passedStatuses.map((status) => status.context)
      ]);
      const missingRequired = requiredContexts.filter((context) => !successfulContexts.has(context));
      if (missingRequired.length) blockers.push(`Required status context(s) not successful: ${missingRequired.join(', ')}.`);
    }

    const latestReview = new Map<string, string>();
    const orderedReviews = [...reviewsResult.values].sort((left, right) =>
      String(left.submitted_at ?? '').localeCompare(String(right.submitted_at ?? ''))
    );
    for (const review of orderedReviews) {
      const login = review.user?.login;
      if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
      latestReview.set(login, review.state);
    }
    const approvals = [...latestReview.values()].filter((state) => state === 'APPROVED').length;
    const changesRequested = [...latestReview.entries()]
      .filter(([, state]) => state === 'CHANGES_REQUESTED')
      .map(([login]) => login);
    let reviewDecision: PullRequestReadiness['review_decision'];
    if (reviewsResult.error || requiredApprovals === undefined) reviewDecision = 'UNKNOWN';
    else if (changesRequested.length) reviewDecision = 'CHANGES_REQUESTED';
    else if (requiredApprovals === 0) reviewDecision = 'NOT_REQUIRED';
    else if (approvals >= requiredApprovals) reviewDecision = 'APPROVED';
    else reviewDecision = 'REVIEW_REQUIRED';
    if (changesRequested.length) blockers.push(`Changes requested by: ${changesRequested.join(', ')}.`);
    if (requiredApprovals !== undefined && approvals < requiredApprovals) {
      blockers.push(`Requires ${requiredApprovals} approving review(s); ${approvals} effective approval(s) found.`);
    }

    const mergeableState = String(body.mergeable_state ?? 'unknown');
    if (body.merged) blockers.push('Already merged.');
    if (body.state !== 'open') blockers.push(`State is ${body.state}, not open.`);
    if (body.draft) blockers.push('Still a draft.');
    if (body.mergeable !== true) blockers.push(`GitHub mergeable verdict is ${String(body.mergeable)}.`);
    if (mergeableState !== 'clean') blockers.push(`GitHub mergeable state is ${mergeableState}, not clean.`);

    return {
      number: body.number,
      title: body.title,
      body: body.body ?? '',
      url: body.html_url ?? '',
      draft: body.draft === true,
      head_ref: body.head.ref,
      base_ref: body.base.ref,
      head_sha: body.head.sha,
      mergeable: body.mergeable,
      mergeable_state: mergeableState,
      state: body.state,
      already_merged: body.merged === true,
      merge_commit_sha: body.merge_commit_sha ?? null,
      checks: {
        total: runsResult.values.length + statuses.length,
        passed: passedRuns.length + passedStatuses.length,
        failed: failing.length,
        pending,
        failing
      },
      review_decision: reviewDecision,
      safe_to_merge: blockers.length === 0,
      blockers
    };
  }

  private repositoryDetails(): { owner: string; repo: string } {
    const [, owner = '', repo = ''] = this.base.match(/^\/repos\/([^/]+)\/([^/]+)$/u) ?? [];
    return { owner: decodeURIComponent(owner), repo: decodeURIComponent(repo) };
  }
}

export function githubRepository(request: GitHubRequest, repository: RepositoryCoordinates | string): GitHubRepositoryOperations {
  return new GitHubRepositoryOperations(request, repository);
}

export function listEntriesFromTree(
  tree: GitHubBranchTree,
  root: string,
  depth: number,
  limit: number
): { entries: GitHubListEntry[]; truncated: boolean } {
  const prefix = root ? `${root}/` : '';
  const rootDepth = root ? root.split('/').filter(Boolean).length : 0;
  const matches = tree.entries.filter((entry) => entry.path !== root && (root === '' || entry.path.startsWith(prefix)));
  const depthFiltered = matches.filter((entry) => entry.path.split('/').filter(Boolean).length - rootDepth <= depth);
  const entries = depthFiltered.slice(0, limit).map((entry) => ({
    // Always repo-relative so forge_files_read / forge_edit can take path as-is.
    // Nested listings previously returned basename-relative paths and ChatGPT
    // then read README.md instead of docs/README.md.
    path: entry.path,
    name: root ? entry.path.slice(prefix.length) : entry.path,
    type: entry.type === 'tree' ? ('directory' as const) : entry.mode === '120000' ? ('symlink' as const) : ('file' as const),
    sizeBytes: entry.type === 'blob' ? entry.size : undefined
  }));
  return { entries, truncated: tree.truncated || depthFiltered.length > entries.length };
}

export async function readBlobFromTree(
  request: GitHubRequest,
  owner: string,
  repo: string,
  tree: GitHubBranchTree,
  path: string,
  options: GitHubReadOptions
): Promise<GitHubReadResult> {
  return githubRepository(request, { owner, name: repo }).readBlob(tree, path, options);
}

export async function listGitHubBranchesWithinBudget(
  request: GitHubRequest,
  base: string,
  deadlineAt = Number.POSITIVE_INFINITY
): Promise<{ branches: GitHubBranch[]; truncated: boolean }> {
  return githubRepository(request, base).listBranches(deadlineAt);
}

export async function listAllGitHubBranches(request: GitHubRequest, base: string): Promise<GitHubBranch[]> {
  return (await githubRepository(request, base).listBranches()).branches;
}

export async function readGitHubBranch(
  request: GitHubRequest,
  base: string,
  branch: string
): Promise<{ status: number; branch?: GitHubBranch }> {
  return githubRepository(request, base).readBranch(branch);
}

export async function deleteGitHubBranchIfUnchanged(
  request: GitHubRequest,
  base: string,
  branch: string,
  expectedSha: string
): Promise<BranchDeleteResult> {
  return githubRepository(request, base).deleteBranchIfUnchanged(branch, expectedSha);
}

export async function readFragmentSource(
  request: GitHubRequest,
  input: { base: string; branch: string; baseSha?: string; path: string }
): Promise<FragmentSourceResult> {
  return githubRepository(request, input.base).readFragmentSource(input);
}

export async function readPullRequestReadiness(
  request: GitHubRequest,
  base: string,
  number: number
): Promise<PullRequestReadiness> {
  return githubRepository(request, base).readPullRequestReadiness(number);
}
