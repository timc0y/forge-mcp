/**
 * Commit straight to GitHub, without a working tree.
 *
 * Forge used to edit a container filesystem and push afterwards. Everything
 * between those two steps was a place for work to exist and not be safe:
 * unpushed commits, a reaped workspace, a 403 that stranded thirty edits, and
 * an agent reporting a real branch and a real SHA for a document that was
 * never on GitHub.
 *
 * Here the remote IS the write target. An edit either becomes a commit on
 * origin or it does not happen at all — there is no third state to
 * misdescribe, and nothing to push afterwards. The container becomes a cache
 * that runs tests, and losing it costs nothing.
 */

/** Minimal GitHub REST transport. Injected so this is testable without network. */
export interface GitHubRequest {
  (path: string, init?: { method?: string; body?: unknown }): Promise<{
    status: number;
    json: unknown;
  }>;
}

export interface RemoteFileChange {
  path: string;
  /** `null` deletes the path. */
  content: string | null;
  encoding?: 'utf-8' | 'base64';
}

export interface RemoteCommitInput {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: RemoteFileChange[];
  /** Bounds the rebase-retry loop when the branch moves under us. */
  maxAttempts?: number;
  /**
   * Git blob SHAs the caller last saw for these paths.
   *
   * Whole-file writes are a blind overwrite: an agent that read a file, then
   * had the branch move underneath it, would revert the other change without
   * either side noticing. Checking what the writer actually saw turns that
   * silent revert into a refusal. Paths absent here are new files or content
   * the caller never read, and are written without a check.
   */
  expectedBlobs?: Record<string, string>;
  /**
   * Commit to create the branch from if it is not on origin yet.
   *
   * `forge_start` now creates the branch on origin before any container
   * exists, so the common case is that this ref is already there. But an
   * agent branch can still be cut without going through `forge_start` (a
   * legacy `forge_workspace_create` call with the default ref, say), and its
   * first edit would then target a ref GitHub has never heard of. Without
   * this the remote-first path 404s on call one, every time.
   */
  baseSha?: string;
  /**
   * Refuse to overwrite an existing file whose current content the caller has
   * not seen.
   *
   * `expectedBlobs` only protects paths the caller happens to have read. This
   * inverts the default: for an agent edit, not having read a file is itself
   * disqualifying, so a dropped session cannot quietly downgrade the check
   * into a blind overwrite. Machine-generated writes (a formatter's output,
   * say) pass false — they are reporting what a file already became.
   */
  requireKnownBase?: boolean;
}

export interface RemoteCommitResult {
  /** Absent when nothing changed — no empty commit is created. */
  commitSha?: string;
  treeSha: string;
  branch: string;
  parentSha: string;
  attempts: number;
  /** True when the branch moved under us and we re-applied onto the new head. */
  rebased: boolean;
  /** True when the resulting tree was identical to the parent's. */
  unchanged: boolean;
  paths: string[];
  /** The branch SHA observed in an authoritative read after the mutation. */
  remoteSha: string;
  /** True only after GitHub read-back matched the commit we attempted to publish. */
  pushVerified: true;
}

export class RemoteCommitConflict extends Error {
  readonly conflictingPaths: string[];
  constructor(paths: string[], reason: 'branch_moved' | 'stale_read' | 'unread' | 'tree_truncated' = 'branch_moved') {
    super(
      reason === 'unread'
        ? `These files already exist and have not been read in this session: ${paths.join(', ')}. ` +
          'Read them first — writing a whole file you have not seen would discard whatever it currently contains.'
        : reason === 'stale_read'
        ? `These paths changed on the branch since they were last read: ${paths.join(', ')}. ` +
          'Read them again and reapply — writing what you last saw would silently revert that change.'
        : reason === 'tree_truncated'
        ? `GitHub's file listing for this repository was too large to return in full, so Forge cannot prove these paths were read (or unchanged) before being overwritten: ${paths.join(', ')}. ` +
          'Read each one again immediately before writing it — a repository this size means an earlier read can no longer be trusted to still be safe.'
        : `The branch moved and these paths changed underneath this edit: ${paths.join(', ')}. ` +
          'Re-read them and reapply — Forge will not silently overwrite someone else\'s change.'
    );
    this.name = 'RemoteCommitConflict';
    this.conflictingPaths = paths;
  }
}

const BLOB_MODE = '100644';

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

export interface CreateBranchRefInput {
  owner: string;
  repo: string;
  branch: string;
  /** Commit the new ref should point at. */
  baseSha: string;
}

export interface CreateBranchRefResult {
  /** False when a concurrent caller (or a prior attempt) created it first. */
  created: boolean;
}

/**
 * Create `refs/heads/<branch>` at `baseSha` — the one way Forge ever mints a
 * branch ref on GitHub, whether that is `forge_start` creating one before any
 * container exists, or {@link commitFilesToBranch} creating one on the fly for
 * a branch an agent is already editing.
 *
 * GitHub uses 422 for both ref collisions and unrelated validation failures.
 * A collision is successful only when an authoritative read proves the ref
 * points at the exact base commit requested by this call.
 */
export async function createBranchRef(
  request: GitHubRequest,
  input: CreateBranchRefInput
): Promise<CreateBranchRefResult> {
  const created = await request(`/repos/${input.owner}/${input.repo}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${input.branch}`, sha: input.baseSha }
  });
  if (created.status === 201) return { created: true };
  if (created.status !== 422) {
    throw new Error(`GitHub branch create failed with HTTP ${created.status}.`);
  }
  const validation = created.json as {
    message?: string;
    errors?: Array<{ code?: string; message?: string } | string>;
  };
  const collision = /reference already exists/iu.test(validation.message ?? '') ||
    (validation.errors ?? []).some((error) =>
      typeof error === 'string'
        ? /already exists/iu.test(error)
        : error.code === 'already_exists' || /already exists/iu.test(error.message ?? '')
    );
  if (!collision) {
    throw new Error(`GitHub branch create failed validation with HTTP 422: ${validation.message ?? 'unknown validation error'}.`);
  }
  const existing = await request(
    `/repos/${input.owner}/${input.repo}/git/ref/heads/${encodePath(input.branch)}`
  );
  const existingSha = existing.status === 200
    ? (existing.json as { object?: { sha?: string } }).object?.sha
    : undefined;
  if (existingSha !== input.baseSha) {
    throw new Error(
      existing.status === 200
        ? `GitHub refused to create ${input.branch}: the existing ref points at ${existingSha ?? 'an unknown commit'}, not requested base ${input.baseSha}.`
        : `GitHub branch create returned a ref collision, and the ref could not be verified (read-back HTTP ${existing.status}).`
    );
  }
  return { created: false };
}

async function expect<T>(
  request: GitHubRequest,
  path: string,
  init: { method?: string; body?: unknown } | undefined,
  ok: (status: number) => boolean,
  what: string
): Promise<T> {
  const response = await request(path, init);
  if (!ok(response.status)) {
    throw new Error(`GitHub ${what} failed with HTTP ${response.status}.`);
  }
  return response.json as T;
}

/**
 * Create a commit containing `files` on `branch`, fast-forward only.
 *
 * If the branch moves between reading its head and updating the ref, the ref
 * update is rejected and we re-apply onto the new head rather than forcing.
 * Re-applying is safe only for paths nobody else touched: if a concurrent
 * commit changed a path this edit also writes, we raise
 * {@link RemoteCommitConflict} instead of clobbering it.
 */
export async function commitFilesToBranch(
  request: GitHubRequest,
  input: RemoteCommitInput
): Promise<RemoteCommitResult> {
  const { owner, repo, branch, files } = input;
  if (!files.length) throw new Error('A remote commit needs at least one file change.');
  const base = `/repos/${owner}/${repo}`;
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  const paths = files.map((file) => file.path);

  // Blobs are content-addressed, so they survive a retry unchanged and only
  // need creating once however many times the ref update is rejected.
  const blobs = new Map<string, string | null>();
  for (const file of files) {
    if (file.content === null) {
      blobs.set(file.path, null);
      continue;
    }
    const blob = await expect<{ sha: string }>(
      request,
      `${base}/git/blobs`,
      { method: 'POST', body: { content: file.content, encoding: file.encoding ?? 'utf-8' } },
      (status) => status === 201,
      'blob create'
    );
    blobs.set(file.path, blob.sha);
  }

  let attempts = 0;
  let rebased = false;
  let firstParent: string | undefined;

  for (;;) {
    attempts += 1;
    const refResponse = await request(`${base}/git/ref/heads/${encodePath(branch)}`);
    if (refResponse.status === 404) {
      if (!input.baseSha) {
        throw new Error(
          `The branch ${branch} does not exist on GitHub and no base commit was supplied to create it from.`
        );
      }
      // 422 means someone created it between our read and our write, which is
      // fine — the next loop reads whatever they created.
      await createBranchRef(request, { owner, repo, branch, baseSha: input.baseSha });
      continue;
    }
    if (refResponse.status !== 200) throw new Error(`GitHub ref read failed with HTTP ${refResponse.status}.`);
    const parentSha = (refResponse.json as { object: { sha: string } }).object.sha;
    firstParent ??= parentSha;

    const parentCommit = await expect<{ tree: { sha: string } }>(
      request,
      `${base}/git/commits/${parentSha}`,
      undefined,
      (status) => status === 200,
      'commit read'
    );

    // On a retry the branch has moved. Refuse to re-apply over a path someone
    // else changed in the meantime — that is a real conflict, not a race we
    // are entitled to win.
    if (attempts > 1 && firstParent && parentSha !== firstParent) {
      rebased = true;
      const changed = await changedPathsBetween(request, base, firstParent, parentSha);
      const collisions = paths.filter((path) => changed.has(path));
      if (collisions.length) throw new RemoteCommitConflict(collisions);
    }

    // What the writer last saw must still be what is on the branch. This runs
    // against the base tree on every attempt, so it also covers the case where
    // the branch had already moved before this call started — which the
    // retry-time check above cannot see.
    const expectedBlobs = input.expectedBlobs;
    if (input.requireKnownBase || (expectedBlobs && Object.keys(expectedBlobs).length)) {
      const listing = await expect<{ tree?: Array<{ path: string; sha: string; type: string }>; truncated?: boolean }>(
        request,
        `${base}/git/trees/${parentCommit.tree.sha}?recursive=1`,
        undefined,
        (status) => status === 200,
        'tree read'
      );
      const current = new Map((listing.tree ?? []).filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
      const stale = Object.entries(expectedBlobs ?? {})
        .filter(([path, sha]) => current.has(path) && current.get(path) !== sha)
        .map(([path]) => path);
      if (stale.length) throw new RemoteCommitConflict(stale, 'stale_read');

      // GitHub sets `truncated: true` on this endpoint for very large trees
      // (~100k entries / 7MB) and silently omits entries past that point.
      // Every check above and below this line reads absence from `current` as
      // "new file, nothing to check" — which is correct only when the tree is
      // complete. On a truncated tree, absence just as easily means "this
      // path exists but got cut", and the guard has no way to tell the two
      // apart. Treating the ambiguous case as "allow" is exactly how this
      // guard degrades open: on a repository large enough to trip GitHub's
      // limit, it would silently stop protecting the very overwrites it
      // exists for. Refuse instead — the only safe reading of "cannot tell".
      if (listing.truncated === true) {
        const unproven = paths.filter((path) => !current.has(path));
        if (unproven.length) throw new RemoteCommitConflict(unproven, 'tree_truncated');
      }

      if (input.requireKnownBase) {
        const unseen = paths.filter((path) => current.has(path) && !(expectedBlobs && path in expectedBlobs));
        if (unseen.length) throw new RemoteCommitConflict(unseen, 'unread');
      }
    }

    const tree = await expect<{ sha: string }>(
      request,
      `${base}/git/trees`,
      {
        method: 'POST',
        body: {
          base_tree: parentCommit.tree.sha,
          tree: files.map((file) => ({
            path: file.path,
            mode: BLOB_MODE,
            type: 'blob',
            sha: blobs.get(file.path) ?? null
          }))
        }
      },
      (status) => status === 201,
      'tree create'
    );

    // Identical tree means the content already matched. Creating an empty
    // commit here would be a lie of a different kind — it would look like work
    // happened. Report `unchanged` instead.
    if (tree.sha === parentCommit.tree.sha) {
      return {
        treeSha: tree.sha,
        branch,
        parentSha,
        attempts,
        rebased,
        unchanged: true,
        paths,
        remoteSha: parentSha,
        pushVerified: true
      };
    }

    const commit = await expect<{ sha: string }>(
      request,
      `${base}/git/commits`,
      { method: 'POST', body: { message: input.message, tree: tree.sha, parents: [parentSha] } },
      (status) => status === 201,
      'commit create'
    );

    const update = await request(`${base}/git/refs/heads/${encodePath(branch)}`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: false }
    });
    if (update.status === 200) {
      const verified = await request(`${base}/git/ref/heads/${encodePath(branch)}`);
      const remoteSha = verified.status === 200
        ? (verified.json as { object?: { sha?: string } }).object?.sha
        : undefined;
      if (remoteSha !== commit.sha) {
        throw new Error(
          verified.status === 200
            ? `GitHub ref update could not be verified: ${branch} points at ${remoteSha ?? 'an unknown commit'}, not ${commit.sha}.`
            : `GitHub ref update could not be verified: read-back failed with HTTP ${verified.status}.`
        );
      }
      return {
        commitSha: commit.sha,
        treeSha: tree.sha,
        branch,
        parentSha,
        attempts,
        rebased,
        unchanged: false,
        paths,
        remoteSha,
        pushVerified: true
      };
    }
    // 422 is GitHub's non-fast-forward: the branch moved between our read and
    // our write. Anything else is a real failure and must not be retried.
    if (update.status !== 422) {
      throw new Error(`GitHub ref update failed with HTTP ${update.status}.`);
    }
    if (attempts >= maxAttempts) {
      throw new Error(
        `The branch ${branch} moved during ${attempts} attempts to update it. Nothing was committed.`
      );
    }
  }
}

async function changedPathsBetween(
  request: GitHubRequest,
  base: string,
  from: string,
  to: string
): Promise<Set<string>> {
  const comparison = await expect<{ files?: Array<{ filename: string }> }>(
    request,
    `${base}/compare/${from}...${to}`,
    undefined,
    (status) => status === 200,
    'compare'
  );
  return new Set((comparison.files ?? []).map((file) => file.filename));
}
