/**
 * Read `forge_files_read` and `forge_files_list` straight from the branch
 * tip on GitHub, instead of the container's checkout.
 *
 * The container is a cache of GitHub and can disagree with it — a commit an
 * agent's own edit just made, a change another session pushed, a branch that
 * moved underneath a stale sync. Reading the branch itself makes that
 * disagreement impossible rather than merely handled: there is no second
 * copy of the file to fall out of sync with the one that is actually true.
 *
 * Two GitHub API calls resolve every read in a call: one to get the branch's
 * tip tree (`fetchBranchTree`), and one `git/blobs/{sha}` per distinct path
 * requested (`readBlobFromTree`). The tree's own blob shas are what
 * `rememberReads` must record — never a re-hash of decoded content, which
 * diverges from git's own blob sha on CRLF line endings and on binary
 * content, and would turn every following `forge_edit` into a spurious
 * `stale_read`.
 */
import { ForgeError, type RepositoryRef } from '@forge/core';
import type { GitHubRequest } from '@forge/git-github';
import type { Env } from './env';
import { githubRequestForWorkspace } from './github';

/**
 * Thrown only for a GitHub failure that looks transient — a network error, a
 * 5xx, a rate limit. Never for a real answer like "this branch/file does not
 * exist", which is signal, not noise, and must reach the agent as-is.
 */
export class GitHubReadUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubReadUnavailable';
  }
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function get(request: GitHubRequest, path: string, what: string): Promise<{ status: number; json: unknown }> {
  try {
    return await request(path);
  } catch (error) {
    throw new GitHubReadUnavailable(
      `GitHub was unreachable while ${what}: ${error instanceof Error ? error.message : 'network error'}.`
    );
  }
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
  /** True when GitHub itself could not return the whole tree (large repos, ~100k entries / 7MB) — entries were silently omitted, not just filtered by depth/limit. */
  truncated: boolean;
  entries: GitHubTreeEntry[];
  byPath: Map<string, GitHubTreeEntry>;
}

/**
 * Resolve `branch`'s tip commit and its full recursive tree — the single
 * source of truth `forge_files_read` and `forge_files_list` now read from.
 * Throws {@link GitHubReadUnavailable} for a transient GitHub failure or a
 * {@link ForgeError} for a real answer (the branch genuinely is not on GitHub).
 */
export async function fetchBranchTree(
  request: GitHubRequest,
  owner: string,
  repo: string,
  branch: string
): Promise<GitHubBranchTree> {
  const base = `/repos/${owner}/${repo}`;
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');

  const refResponse = await get(request, `${base}/git/ref/heads/${encodedBranch}`, `reading the tip of ${branch}`);
  if (refResponse.status === 404) {
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
    throw new ForgeError({
      code: 'FORGE_PERMISSION_DENIED',
      message: `GitHub returned HTTP ${refResponse.status} reading the tip of ${branch} on ${owner}/${repo}. Call forge_access for this repository to see whether Forge still has permission, then retry.`,
      retryable: false,
      details: { owner, repo, branch, status: refResponse.status }
    });
  }
  const commitSha = (refResponse.json as { object: { sha: string } }).object.sha;

  const commitResponse = await get(request, `${base}/git/commits/${commitSha}`, `reading commit ${commitSha}`);
  if (isTransientStatus(commitResponse.status)) {
    throw new GitHubReadUnavailable(`GitHub returned HTTP ${commitResponse.status} reading commit ${commitSha}.`);
  }
  if (commitResponse.status !== 200) {
    throw new ForgeError({
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: `GitHub returned HTTP ${commitResponse.status} reading the commit at the tip of ${branch}. Retry the read; if it keeps failing, call forge_access for this repository.`,
      retryable: true,
      details: { owner, repo, branch, commitSha, status: commitResponse.status }
    });
  }
  const treeSha = (commitResponse.json as { tree: { sha: string } }).tree.sha;

  const treeResponse = await get(request, `${base}/git/trees/${treeSha}?recursive=1`, `reading the tree at ${treeSha}`);
  if (isTransientStatus(treeResponse.status)) {
    throw new GitHubReadUnavailable(`GitHub returned HTTP ${treeResponse.status} reading the file tree at ${treeSha}.`);
  }
  if (treeResponse.status !== 200) {
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

/** Simple bound so a wedged coordinator DO fails fast instead of hanging the call. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))
  ]);
}

export interface BranchTreeContext {
  repository: RepositoryRef;
  branch: string;
  tree: GitHubBranchTree;
  /**
   * The same authenticated GitHub transport the tree read used. Reuse this
   * for any follow-up blob reads instead of calling
   * `githubRequestForWorkspace` again per path: it mints a fresh installation
   * token on every call (no caching), so re-deriving it once per file in a
   * multi-path batch would mean up to 20 live token mints for one read.
   */
  request: GitHubRequest;
}

/**
 * Look up the workspace's repository and current branch, then read that
 * branch's tip tree from GitHub. This is the one round trip
 * `forge_files_read` and `forge_files_list` both start from.
 */
export async function resolveBranchTree(
  env: Env,
  identity: Parameters<typeof githubRequestForWorkspace>[1],
  workspace: { getAuthorizationBinding(): Promise<unknown> }
): Promise<BranchTreeContext> {
  const state = await withTimeout(
    workspace.getAuthorizationBinding() as Promise<{ repository: RepositoryRef; requestedRef: string; currentBranch?: string }>,
    15_000
  );
  if (!state) {
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: 'The workspace did not respond in time, so Forge cannot tell which branch or repository to read from GitHub. Retry the same call — it usually succeeds on the next attempt.',
      retryable: true
    });
  }
  const branch = state.currentBranch ?? state.requestedRef;
  if (!branch) {
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: 'This workspace has no branch yet, so there is nothing on GitHub to read. Call forge_workspace_get to check readiness, or forge_workspace_create if it has not been created yet.',
      retryable: true
    });
  }
  const request = await githubRequestForWorkspace(env, identity, { repository: state.repository });
  const tree = await fetchBranchTree(request, state.repository.owner, state.repository.name, branch);
  return { repository: state.repository, branch, tree, request };
}

export interface GitHubReadOptions {
  startLine?: number;
  endLine?: number;
  maxBytes: number;
}

export interface GitHubReadResult {
  path: string;
  content: string;
  /** Bytes actually held by `content` — describes the slice just returned, never the whole file behind it. */
  sizeBytes: number;
  truncated: boolean;
  /** The git blob sha GitHub reported for this path in the tree just read. Record this with rememberReads — never a re-hash of `content`, which diverges from git's own hash on CRLF and binary content. */
  blobSha: string;
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

/**
 * Read one path's content, from a tree already fetched by
 * {@link fetchBranchTree}. Throws {@link ForgeError} `FORGE_FILE_NOT_FOUND`
 * when the path genuinely is not on the branch — that is a real answer the
 * tree just gave, not something to retry or fall back on.
 */
export async function readBlobFromTree(
  request: GitHubRequest,
  owner: string,
  repo: string,
  tree: GitHubBranchTree,
  path: string,
  options: GitHubReadOptions
): Promise<GitHubReadResult> {
  const entry = tree.byPath.get(path);
  if (!entry || entry.type !== 'blob') {
    throw new ForgeError({
      code: 'FORGE_FILE_NOT_FOUND',
      message: `${path} does not exist on the branch Forge just read from GitHub. List the directory with forge_files_list to see what is actually there, or write it with forge_edit to create it.`,
      retryable: false,
      details: { path }
    });
  }
  const blobResponse = await get(request, `/repos/${owner}/${repo}/git/blobs/${entry.sha}`, `reading the blob for ${path}`);
  if (isTransientStatus(blobResponse.status)) {
    throw new GitHubReadUnavailable(`GitHub returned HTTP ${blobResponse.status} reading the blob for ${path}.`);
  }
  if (blobResponse.status !== 200) {
    throw new ForgeError({
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: `GitHub returned HTTP ${blobResponse.status} reading ${path}. Retry the read; if it keeps failing, call forge_access for this repository.`,
      retryable: true,
      details: { path, status: blobResponse.status }
    });
  }
  const body = blobResponse.json as { content?: string };
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

export interface GitHubListEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  sizeBytes?: number;
}

/**
 * List entries under `root` (repo-relative; `''` for the whole repository),
 * from a tree already fetched by {@link fetchBranchTree}. Paths come back
 * relative to `root` — the same contract the container listing already has,
 * so forge_edit and forge_files_read still accept what this hands back.
 */
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
  const limited = depthFiltered.slice(0, limit).map((entry) => ({
    path: root ? entry.path.slice(prefix.length) : entry.path,
    type: entry.type === 'tree' ? ('directory' as const) : entry.mode === '120000' ? ('symlink' as const) : ('file' as const),
    sizeBytes: entry.type === 'blob' ? entry.size : undefined
  }));
  return {
    entries: limited,
    // Either GitHub's own tree read was itself incomplete (a repository large
    // enough to trip GitHub's truncation limit), or the depth/limit bound cut
    // what it did return — either way the caller did not see everything,
    // which is exactly what `truncated` promises to report.
    truncated: tree.truncated || depthFiltered.length > limited.length
  };
}
