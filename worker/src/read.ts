/**
 * forge_read is one question — "show me what's there" — asked at four zoom
 * levels: which repos exist, what a tree holds, what specific files contain,
 * and what changed between two refs. Each function answers one zoom level
 * through the caller's already-authenticated GitHubRequest; none of them
 * builds a client, retries, or resolves auth — that seam is someone else's.
 */
import { type GitHubRequest, type RepoRef, type Comparison, type ChangedFile, formatRepo } from './contracts';
import { ForgeError } from './errors';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Git refs may contain slashes ("feature/x"); each segment needs its own encoding. */
function encodeRefSegments(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function encodeContentPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Workers has `atob` but no `Buffer`; decode base64 straight to bytes. */
function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/\n/g, '');
  return Uint8Array.from(atob(clean), (char) => char.charCodeAt(0));
}

/** A NUL byte in the first few KB is the same signal GitHub's own UI uses for "binary". */
function looksBinary(bytes: Uint8Array): boolean {
  const scanLength = Math.min(bytes.length, 8000);
  for (let i = 0; i < scanLength; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function repoRequest(
  request: GitHubRequest,
  repo: RepoRef,
  path: string
): ReturnType<GitHubRequest> {
  return request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${path}`);
}

function upstreamUnavailable(status: number, what: string): ForgeError {
  return new ForgeError({
    code: 'FORGE_UPSTREAM_UNAVAILABLE',
    message: `GitHub returned HTTP ${status} while ${what}.`,
    retryable: true,
    details: { status }
  });
}

// ---------------------------------------------------------------------------
// Which repos
// ---------------------------------------------------------------------------

interface GitHubInstallationRepo {
  name: string;
  owner: { login: string };
  description: string | null;
  default_branch: string;
  private: boolean;
  pushed_at: string;
}

export async function listRepos(
  request: GitHubRequest,
  query?: string
): Promise<Array<{ repo: string; description: string | null; defaultBranch: string; private: boolean; pushedAt: string }>> {
  const all: GitHubInstallationRepo[] = [];
  // No Link-header parsing needed here: GitHub's installation-repositories
  // list is a flat page walk, and a short final page is itself the stop
  // signal.
  for (let page = 1; ; page += 1) {
    const response = await request(`/installation/repositories?per_page=100&page=${page}`);
    if (response.status !== 200) {
      throw upstreamUnavailable(response.status, 'listing repositories for this installation');
    }
    const body = response.json as { repositories?: GitHubInstallationRepo[] };
    const repositories = body.repositories ?? [];
    all.push(...repositories);
    if (repositories.length < 100) break;
  }

  const needle = query?.toLowerCase();
  const matched = needle ? all.filter((r) => r.name.toLowerCase().includes(needle)) : all;

  return matched.map((r) => ({
    repo: formatRepo({ owner: r.owner.login, name: r.name }),
    description: r.description,
    defaultBranch: r.default_branch,
    private: r.private,
    pushedAt: r.pushed_at
  }));
}

// ---------------------------------------------------------------------------
// What a tree holds
// ---------------------------------------------------------------------------

interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

export async function readTree(
  request: GitHubRequest,
  repo: RepoRef,
  ref: string,
  path?: string
): Promise<{ entries: Array<{ path: string; type: 'file' | 'dir'; size: number }>; truncated: boolean }> {
  // The git trees endpoint accepts a ref name directly (branch, tag, or
  // commit SHA) — there's no need to resolve ref -> commit -> tree ourselves.
  const response = await repoRequest(request, repo, `/git/trees/${encodeRefSegments(ref)}?recursive=1`);
  if (response.status === 404) {
    throw new ForgeError({
      code: 'FORGE_NOT_FOUND',
      message: `${ref} was not found on ${formatRepo(repo)}.`,
      details: { repo: formatRepo(repo), ref }
    });
  }
  if (response.status !== 200) {
    throw upstreamUnavailable(response.status, `reading the tree at ${ref} on ${formatRepo(repo)}`);
  }

  const body = response.json as { tree?: GitHubTreeEntry[]; truncated?: boolean };
  const raw = body.tree ?? [];

  // Narrow to a subtree by prefix. GitHub's recursive listing includes the
  // enclosing directory as its own 'tree' entry; that entry names the
  // subtree rather than living inside it, so it's excluded, not echoed back.
  const scoped = path ? raw.filter((entry) => entry.path !== path && entry.path.startsWith(`${path}/`)) : raw;

  const entries = scoped
    // A submodule ('commit') is neither a file Forge can read nor a directory
    // Forge can walk into — surfacing it as either would mislead the caller.
    .filter((entry): entry is GitHubTreeEntry & { type: 'blob' | 'tree' } => entry.type === 'blob' || entry.type === 'tree')
    .map((entry) => ({
      path: entry.path,
      type: entry.type === 'blob' ? ('file' as const) : ('dir' as const),
      size: entry.type === 'blob' ? entry.size ?? 0 : 0
    }));

  // GitHub silently drops entries once its own recursive-tree response
  // exceeds its size limit; a caller who trusted an unmarked list would think
  // a large repo was smaller than it is.
  return { entries, truncated: body.truncated === true };
}

// ---------------------------------------------------------------------------
// What specific files contain
// ---------------------------------------------------------------------------

interface GitHubContentFile {
  type?: string;
  encoding?: string;
  content?: string;
  size?: number;
}

export async function readFiles(
  request: GitHubRequest,
  repo: RepoRef,
  ref: string,
  paths: string[],
  maxBytes: number
): Promise<{ files: Array<{ path: string; content: string; bytes: number; truncated: boolean }>; skipped: Array<{ path: string; reason: string }> }> {
  const fetched = await Promise.all(
    paths.map(async (path) => ({
      path,
      response: await repoRequest(request, repo, `/contents/${encodeContentPath(path)}?ref=${encodeURIComponent(ref)}`)
    }))
  );

  // One bad path must not lose the other four.
  //
  // The client cannot loop, so a caller that asks for five files and gets an
  // exception because one was renamed has to spend another whole turn to
  // learn which. A missing path is reported next to the file it failed to be,
  // and the caller still gets everything that did resolve.
  //
  // Every path failing is different: that means the ref or the repository is
  // wrong, not the paths, and a caller told "4 files skipped" would go looking
  // in the wrong place. So it is raised.
  const unreachable = fetched.filter(({ response }) => response.status !== 200);
  if (unreachable.length > 0 && unreachable.length === fetched.length) {
    const status = unreachable[0]?.response.status ?? 0;
    if (status === 404) {
      throw new ForgeError({
        code: 'FORGE_NOT_FOUND',
        message:
          `None of those paths exist at ${ref} on ${formatRepo(repo)}. ` +
          'Check the ref, or read the tree first to see what is there.',
        details: { repo: formatRepo(repo), ref, paths }
      });
    }
    throw upstreamUnavailable(status, `reading ${paths.length} paths at ${ref} on ${formatRepo(repo)}`);
  }

  const files: Array<{ path: string; content: string; bytes: number; truncated: boolean }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let spent = 0;

  for (const { path, response } of fetched) {
    if (response.status === 404) {
      skipped.push({ path, reason: `not found at ${ref}` });
      continue;
    }
    if (response.status !== 200) {
      skipped.push({ path, reason: `GitHub returned ${response.status}` });
      continue;
    }

    const body = response.json as GitHubContentFile | GitHubContentFile[];
    if (Array.isArray(body)) {
      skipped.push({ path, reason: 'is a directory, not a file' });
      continue;
    }
    if (body.type !== undefined && body.type !== 'file') {
      skipped.push({ path, reason: `is a ${body.type}, not a regular file` });
      continue;
    }
    if (typeof body.content !== 'string' || body.encoding !== 'base64') {
      // The contents API omits inline content past 1 MB regardless of
      // maxBytes; there's no cheaper way to learn that than asking.
      skipped.push({ path, reason: 'too large for GitHub to return inline content (over 1 MB)' });
      continue;
    }

    const bytes = decodeBase64(body.content);
    if (looksBinary(bytes)) {
      skipped.push({ path, reason: 'binary file, not returned as text' });
      continue;
    }

    const size = body.size ?? bytes.length;
    if (size > maxBytes) {
      skipped.push({ path, reason: `file is ${size} bytes, larger than the ${maxBytes} byte budget` });
      continue;
    }
    if (spent + size > maxBytes) {
      skipped.push({ path, reason: `the ${maxBytes} byte budget was already spent by earlier files` });
      continue;
    }

    spent += size;
    files.push({
      path,
      content: new TextDecoder().decode(bytes),
      bytes: size,
      // Forge never returns a partial file: a file either fits the remaining
      // budget whole or is skipped outright. This stays false today because
      // that's the only outcome this function produces — a real partial read
      // would be a genuinely new capability, not a value to fake here.
      truncated: false
    });
  }

  return { files, skipped };
}

// ---------------------------------------------------------------------------
// What changed between two refs
// ---------------------------------------------------------------------------

interface GitHubComparisonFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GitHubComparison {
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  ahead_by: number;
  behind_by: number;
  files?: GitHubComparisonFile[];
}

function mapFileStatus(status: string): ChangedFile['status'] {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'renamed':
      return 'renamed';
    // GitHub also sends 'copied', 'changed', and 'unchanged'; none of those
    // has its own place in Comparison's status union, and calling an
    // unrecognised status something invented would be a guess, not a fact.
    default:
      return 'modified';
  }
}

export async function compare(
  request: GitHubRequest,
  repo: RepoRef,
  base: string,
  head: string,
  patchPaths?: string[]
): Promise<Comparison> {
  const basehead = `${encodeRefSegments(base)}...${encodeRefSegments(head)}`;
  const response = await repoRequest(request, repo, `/compare/${basehead}`);
  if (response.status === 404) {
    throw new ForgeError({
      code: 'FORGE_NOT_FOUND',
      message: `Could not compare ${base}...${head} on ${formatRepo(repo)}: one or both refs were not found.`,
      details: { repo: formatRepo(repo), base, head }
    });
  }
  if (response.status !== 200) {
    throw upstreamUnavailable(response.status, `comparing ${base}...${head} on ${formatRepo(repo)}`);
  }

  const body = response.json as GitHubComparison;
  const rawFiles = body.files ?? [];
  const wantPatch = new Set(patchPaths ?? []);

  const files: ChangedFile[] = rawFiles.map((file) => {
    const changed: ChangedFile = {
      path: file.filename,
      status: mapFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions
    };
    // Patch text is the one thing that must stay opt-in: it's what makes the
    // default summary depth small, so it's attached only for paths the
    // caller actually asked about, and only when GitHub had one to give.
    if (wantPatch.has(file.filename) && typeof file.patch === 'string') {
      changed.patch = file.patch;
    }
    return changed;
  });

  // GitHub caps this endpoint at 300 files and signals more the way any
  // paginated GitHub list does: a Link header with rel="next". It gives no
  // cheap way to fetch the rest of a huge diff, so the honest move is to say
  // it's incomplete rather than paginate a possibly enormous comparison.
  const truncated = /rel="next"/.test(response.headers.get('Link') ?? '') || rawFiles.length > 300;

  return {
    // Same reasoning as the counts: an unrecognised status must not become a
    // schema violation on a read that otherwise succeeded.
    status:
      body.status === 'identical' || body.status === 'ahead' || body.status === 'behind' || body.status === 'diverged'
        ? body.status
        : 'diverged',
    // GitHub's own fields, but treated as untrusted: these land directly in
    // required output-schema numbers, and an interposed proxy or a truncated
    // body would turn a successful read into a schema rejection the model can
    // do nothing about.
    aheadBy: typeof body.ahead_by === 'number' ? body.ahead_by : 0,
    behindBy: typeof body.behind_by === 'number' ? body.behind_by : 0,
    files,
    truncated
  };
}
