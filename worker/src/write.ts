/**
 * The one path by which anything becomes durable.
 *
 * Forge used to edit a filesystem and push afterwards. Everything between those
 * two steps was somewhere work could exist and not be safe: unpushed commits, a
 * reaped workspace holding the only copy, a 403 stranding thirty edits, and a
 * tool reporting a real branch and a real SHA for a file that was never on
 * origin (`ca0a99a`). Here the remote IS the write target: blobs, one tree, one
 * commit, one guarded ref update. The commit exists on GitHub before this
 * function returns, so there is no push step, nothing to strand, and no third
 * state to misdescribe. An edit becomes a commit on origin or nothing happened.
 *
 * Concurrency is Forge's problem, not the caller's. GitHub already refuses a
 * non-fast-forward ref update; that refusal is the whole concurrency design.
 * We never force, we re-apply onto the new head, and we raise a conflict rather
 * than overwrite a path someone else touched.
 */

import { formatRepo } from './contracts';
import type { CommitReceipt, FileWrite, GitHubRequest, RepoRef } from './contracts';
import { ForgeError } from './errors';

/**
 * Chat-facing bounds, deliberately small. The client is a phone conversation,
 * not an agent: a write it cannot re-emit in full is a write that arrives
 * truncated, and a truncated write passes every other check we have. Refusing
 * at the boundary is the only place truncation is still visible.
 */
const MAX_FILES = 10;
const MAX_CONTENT_BYTES = 200 * 1024;

/** Three attempts is enough for a branch that is moving; more just hides that. */
const MAX_ATTEMPTS = 3;

/**
 * How long the pre-commit work may take before this gives up.
 *
 * The client cuts a request near 60 seconds, and a Worker keeps running after
 * it disconnects — so without a ceiling, a slow write dies in the transport
 * while continuing remotely, which is `9c78d0f`: the caller cannot wait for it,
 * cannot read it, and cannot tell whether writing again would duplicate work.
 *
 * The budget deliberately covers only the phase before the ref update. Once
 * GitHub accepts the commit the work is durable, and no clock may turn that
 * into a failure.
 */
const WRITE_BUDGET_MS = 40_000;
/**
 * Above this, an existing file may only be edited by fragment. Small enough
 * that re-emitting it whole is a plausible thing to have composed deliberately;
 * large enough that configs, plans and short documents are unaffected.
 */
const WHOLE_FILE_REWRITE_BYTES = 8 * 1024;

/**
 * GitHub's compare endpoint caps its file list at 300. Past that we cannot
 * prove a concurrent commit missed our paths, and "cannot tell" must read as
 * refuse — a guard that degrades open is worse than no guard.
 */
const COMPARE_FILE_CAP = 300;

/**
 * Every file Forge writes from a chat is a regular file. Trap: this rewrites an
 * existing 100755 entry as 100644, dropping its executable bit. Forge does not
 * run code, so nothing here depends on that bit; a caller that needs it must
 * not use this path.
 */
const BLOB_MODE = '100644';

type GitHubResponse = Awaited<ReturnType<GitHubRequest>>;

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob';
  /** `null` removes the path from the new tree — this is how a delete happens. */
  sha: string | null;
}

/**
 * Write `files` onto `branch` as exactly one commit, creating the branch from
 * `baseBranch` if it is not there yet.
 *
 * Returns `outcome: 'unchanged'` — with the existing head — when the resulting
 * tree is identical to the current one. An empty commit would look like work
 * happened, which is the same class of lie as reporting an unpushed SHA.
 */
export async function commitFiles(
  request: GitHubRequest,
  repo: RepoRef,
  branch: string,
  baseBranch: string,
  message: string,
  files: FileWrite[]
): Promise<CommitReceipt> {
  validate(message, files);

  const api = `/repos/${repo.owner}/${repo.name}`;
  const paths = files.map((file) => file.path);
  const deadline = Date.now() + WRITE_BUDGET_MS;

  const outOfTime = (): boolean => Date.now() > deadline;
  const giveUp = (stage: string): never => {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message:
        `GitHub was too slow to finish this write (${stage}), so it was stopped before committing. ` +
        'Nothing was committed. Write again when GitHub is responding normally.',
      retryable: true,
      details: { branch, paths, stage }
    });
  };

  // The head we resolve every fragment edit against. Reading content at this
  // exact SHA — not at the branch name — means a branch that moves mid-write
  // cannot make us apply a fragment to a file we never saw.
  const original = await resolveHead(request, api, branch, baseBranch);

  if (outOfTime()) giveUp('resolving the branch');
  const resolved = await resolveContents(request, api, original, files);

  if (outOfTime()) giveUp('reading the files being edited');

  // Blobs are content-addressed, so they are identical however many times the
  // ref update is rejected: create them once, in parallel, outside the loop.
  // An abandoned attempt leaves unreferenced blobs, which are inert and cost
  // nothing — there is no cleanup step to get wrong.
  const blobs = await createBlobs(request, api, resolved);

  const entries: TreeEntry[] = resolved.map((file) => ({
    path: file.path,
    mode: BLOB_MODE,
    type: 'blob',
    sha: blobs.get(file.path) ?? null
  }));

  let head = original;
  let lastRejection: string | null = null;

  for (let attempt = 1; ; attempt += 1) {
    // Checked between attempts, never mid-commit: a retry that starts inside
    // the last second is how a write ends up in flight with nobody waiting.
    if (outOfTime()) giveUp(`retrying a moving branch (attempt ${attempt})`);

    const baseTree = await readCommitTree(request, api, head);

    // The branch moved under us. Re-applying is only safe for paths nobody else
    // touched: a concurrent commit to a path this write also writes is a real
    // conflict, not a race we are entitled to win by being second.
    if (head !== original) {
      await assertNoOverlap(request, api, original, head, paths);
    }

    const tree = await createTree(request, api, baseTree, entries, paths);

    // Identical tree: the content already matched. No commit, and say so.
    if (tree === baseTree) {
      return receipt(repo, branch, head, 'unchanged', paths);
    }

    const commit = await createCommit(request, api, message, tree, head);

    const update = await request(`${api}/git/refs/heads/${encodePath(branch)}`, {
      method: 'PATCH',
      // force:false is the entire lock. GitHub arbitrates; Forge never wins by
      // overwriting.
      body: { sha: commit, force: false }
    });

    if (update.status === 200) {
      // The PATCH response IS the post-update ref, so this is origin's own
      // account of where the branch points — no second read, which would only
      // add latency and a chance of hitting a stale replica.
      const landed = readSha(update.json);
      if (landed !== commit) {
        throw new ForgeError({
          code: 'FORGE_UPSTREAM_UNAVAILABLE',
          message:
            `GitHub accepted the update to ${branch} but reports it at ` +
            `${landed ?? 'an unknown commit'}, not ${commit}. Read the branch before writing again.`,
          retryable: true
        });
      }
      return receipt(repo, branch, commit, 'committed', paths);
    }

    // 422 is GitHub's non-fast-forward: the branch moved between our read and
    // our write. Anything else is a real failure and must not be retried.
    if (update.status !== 422) throw githubError(update, `update of ${branch}`);
    lastRejection = githubMessage(update.json);

    if (attempt >= MAX_ATTEMPTS) {
      throw new ForgeError({
        code: 'FORGE_CONFLICT',
        message:
          `${branch} moved during all ${MAX_ATTEMPTS} attempts to update it, so nothing was committed. ` +
          `Read the change and write again.`,
        retryable: true,
        details: { branch, attempts: MAX_ATTEMPTS, paths, github: lastRejection }
      });
    }

    const moved = await readRef(request, api, branch);
    if (moved === null) {
      throw new ForgeError({
        code: 'FORGE_NOT_FOUND',
        message: `${branch} was deleted while this write was in flight. Nothing was committed.`,
        details: { branch }
      });
    }
    head = moved;
  }
}

// ---------------------------------------------------------------------------
// Validation — refusals that happen before anything touches GitHub
// ---------------------------------------------------------------------------

function validate(message: string, files: FileWrite[]): void {
  if (!message.trim()) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'A commit needs a message saying what changed.'
    });
  }
  if (files.length === 0) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'A write needs at least one file.'
    });
  }
  if (files.length > MAX_FILES) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message:
        `This write has ${files.length} files; at most ${MAX_FILES} can be written per call. ` +
        `Split it into several writes — each one commits on its own.`,
      details: { limit: MAX_FILES, given: files.length }
    });
  }

  const seen = new Set<string>();
  let bytes = 0;

  for (const file of files) {
    assertWritablePath(file.path);
    // Two writes to one path in one call: the tree API would silently take the
    // last, and the caller would never learn which one it lost.
    if (seen.has(file.path)) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: `${file.path} appears twice in this write. Combine the changes into one entry.`,
        details: { path: file.path }
      });
    }
    seen.add(file.path);

    const replacements = file.replace ?? [];
    const writesContent = file.content !== undefined;
    if (writesContent && replacements.length > 0) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: `${file.path} has both whole-file content and fragment replacements. Send one or the other.`,
        details: { path: file.path }
      });
    }
    if (!writesContent && replacements.length === 0) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: `${file.path} has nothing to write: send content (or null to delete it), or replacements.`,
        details: { path: file.path }
      });
    }

    if (typeof file.content === 'string') bytes += byteLength(file.content);
    for (const replacement of replacements) {
      // An empty `old` matches at every position, so "unambiguous" is
      // unachievable for it. Refuse rather than resolve.
      if (replacement.old === '') {
        throw new ForgeError({
          code: 'FORGE_VALIDATION_FAILED',
          message: `A replacement in ${file.path} has empty text to match. Say which text to replace.`,
          details: { path: file.path }
        });
      }
      bytes += byteLength(replacement.new);
    }
  }

  if (bytes > MAX_CONTENT_BYTES) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message:
        `This write carries ${bytes} bytes of new content; at most ${MAX_CONTENT_BYTES} ` +
        `(200KB) are accepted per call. Split it into several writes rather than shortening a file.`,
      details: { limit: MAX_CONTENT_BYTES, given: bytes }
    });
  }
}

function assertWritablePath(path: string): void {
  const segments = path.split('/');
  const usable =
    path.length > 0 &&
    !path.startsWith('/') &&
    !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
  if (!usable) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `${JSON.stringify(path)} is not a writable path. Use a repository-relative path such as docs/plan.md.`,
      details: { path }
    });
  }
}

// ---------------------------------------------------------------------------
// Content: what each path should contain after this write
// ---------------------------------------------------------------------------

interface ResolvedFile {
  path: string;
  /** `null` deletes. */
  content: string | null;
}

async function resolveContents(
  request: GitHubRequest,
  api: string,
  head: string,
  files: FileWrite[]
): Promise<ResolvedFile[]> {
  return Promise.all(
    files.map(async (file): Promise<ResolvedFile> => {
      if (file.content !== undefined) {
        // Whole-file writes are for new or small files. Enforced here, not
        // advised in a prompt, because a tool the model can reach is one it
        // will reach.
        //
        // The failure this prevents has no race in it and so trips no other
        // guard: read a file (which reads the default branch), re-emit it
        // whole, and any commit already made on this change to that path is
        // gone. It is `6712ab8` — silent whole-file truncation — arriving
        // through the one door the concurrency checks do not watch.
        if (file.content !== null) {
          const existing = await statTextFile(request, api, file.path, head);
          if (existing !== null && existing > WHOLE_FILE_REWRITE_BYTES) {
            throw new ForgeError({
              code: 'FORGE_VALIDATION_FAILED',
              message:
                `${file.path} already exists on this change and is ${existing} bytes, too large to replace wholesale. ` +
                'Send `replace` fragments instead, so nothing you did not send is lost.',
              details: { path: file.path, bytes: existing, limit: WHOLE_FILE_REWRITE_BYTES }
            });
          }
        }
        return { path: file.path, content: file.content };
      }
      // Forge does the reading, so what lands is the real file with a bounded
      // change applied. Nothing the caller omits can be lost, which is what a
      // whole-file re-emission risks every time.
      const current = await readTextFile(request, api, file.path, head);
      return { path: file.path, content: applyReplacements(file.path, current, file.replace ?? []) };
    })
  );
}

/**
 * Unambiguous fragment replacement. Absent or repeated text is refused, never
 * guessed: picking the first of several matches silently edits a line the
 * caller never meant, and there is no receipt that would show it.
 */
function applyReplacements(
  path: string,
  current: string,
  replacements: Array<{ old: string; new: string; all?: boolean }>
): string {
  let next = current;
  for (const replacement of replacements) {
    const first = next.indexOf(replacement.old);
    if (first === -1) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message:
          `That text is absent from ${path}: ${preview(replacement.old)}. ` +
          `Read the file again — it is not what you expected.`,
        details: { path, reason: 'absent' }
      });
    }
    if (replacement.all === true) {
      next = next.split(replacement.old).join(replacement.new);
      continue;
    }
    if (next.indexOf(replacement.old, first + replacement.old.length) !== -1) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message:
          `That text appears more than once in ${path}: ${preview(replacement.old)}. ` +
          `Include enough surrounding context to identify one occurrence, or set all:true to change every one.`,
        details: { path, reason: 'repeated' }
      });
    }
    next = `${next.slice(0, first)}${replacement.new}${next.slice(first + replacement.old.length)}`;
  }
  return next;
}

function preview(value: string): string {
  return JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}…` : value);
}

/**
 * The size of `path` on `ref`, or null if it does not exist there. Metadata
 * only — the caller is about to replace the content, so fetching it would be
 * bytes spent to learn nothing.
 */
async function statTextFile(
  request: GitHubRequest,
  api: string,
  path: string,
  ref: string
): Promise<number | null> {
  const response = await request(`${api}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  if (response.status === 404) return null;
  if (response.status !== 200) return null;
  const body = response.json as { type?: string; size?: number } | null;
  if (!body || body.type !== 'file') return null;
  return typeof body.size === 'number' ? body.size : null;
}

async function readTextFile(
  request: GitHubRequest,
  api: string,
  path: string,
  ref: string
): Promise<string> {
  const response = await request(`${api}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  if (response.status === 404) {
    throw new ForgeError({
      code: 'FORGE_NOT_FOUND',
      message: `${path} does not exist on this branch, so there is no fragment to replace. Send content to create it.`,
      details: { path }
    });
  }
  if (response.status !== 200) throw githubError(response, `read of ${path}`);

  const body = response.json as { type?: unknown; content?: unknown; encoding?: unknown };
  if (typeof body.type === 'string' && body.type !== 'file') {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `${path} is a ${body.type}, not a file.`,
      details: { path }
    });
  }
  // GitHub returns `encoding: "none"` above 1MB. A fragment edit applied to
  // content we cannot see would be a guess, and the guess writes the whole file.
  if (body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `${path} is too large for GitHub to return inline, so it cannot be edited by fragment.`,
      details: { path }
    });
  }
  return decodeUtf8(body.content, path);
}

function decodeUtf8(base64: string, path: string): string {
  const binary = atob(base64.replaceAll('\n', ''));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    // fatal:true so a binary file fails loudly here rather than round-tripping
    // through replacement characters and being written back corrupted.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `${path} is not UTF-8 text, so a fragment replacement cannot be applied to it.`,
      details: { path }
    });
  }
}

// ---------------------------------------------------------------------------
// GitHub git-data plumbing
// ---------------------------------------------------------------------------

async function createBlobs(
  request: GitHubRequest,
  api: string,
  files: ResolvedFile[]
): Promise<Map<string, string | null>> {
  const blobs = new Map<string, string | null>();
  await Promise.all(
    files.map(async (file) => {
      if (file.content === null) {
        blobs.set(file.path, null);
        return;
      }
      const response = await request(`${api}/git/blobs`, {
        method: 'POST',
        body: encodeBlob(file.path, file.content)
      });
      if (response.status !== 201) throw githubError(response, `blob create for ${file.path}`);
      const sha = readField(response.json, 'sha');
      if (sha === null) {
        throw new ForgeError({
          code: 'FORGE_UPSTREAM_UNAVAILABLE',
          message: `GitHub created a blob for ${file.path} without returning its SHA.`,
          retryable: true
        });
      }
      blobs.set(file.path, sha);
    })
  );
  return blobs;
}

/**
 * Text is the common case and stays readable in the blob API. Binary arrives as
 * a byte-per-code-unit string (the only way bytes survive a JSON channel) and
 * must go as base64: sending it as "utf-8" would re-encode every byte above
 * 0x7F and write a file that is not what the caller sent.
 */
function encodeBlob(path: string, content: string): { content: string; encoding: 'utf-8' | 'base64' } {
  // A lone surrogate is only unpaired when the /u regex sees it as its own code
  // point; a real pair is one code point and never matches this class. Such a
  // string has no faithful UTF-8 encoding at all.
  const lone = /[\uD800-\uDFFF]/u.test(content);
  // A NUL means these are bytes, not text. Sending bytes as "utf-8" would
  // re-encode everything above 0x7F into two bytes and write a file that is not
  // what the caller sent — the silent way to corrupt an image.
  const binary = lone || content.includes('\u0000');
  if (!binary) return { content, encoding: 'utf-8' };
  // Bytes reach a JSON channel one byte per code unit; btoa reads exactly that.
  if (!lone && /^[\u0000-\u00FF]*$/u.test(content)) return { content: btoa(content), encoding: 'base64' };
  throw new ForgeError({
    code: 'FORGE_VALIDATION_FAILED',
    message:
      `${path} is neither valid text nor a byte string, so Forge cannot write it faithfully. ` +
      `Send binary content one byte per character.`,
    details: { path }
  });
}

async function readCommitTree(request: GitHubRequest, api: string, commit: string): Promise<string> {
  const response = await request(`${api}/git/commits/${commit}`);
  if (response.status !== 200) throw githubError(response, `read of commit ${commit}`);
  const tree = response.json as { tree?: { sha?: unknown } };
  const sha = tree.tree?.sha;
  if (typeof sha !== 'string') {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `GitHub returned commit ${commit} without a tree.`,
      retryable: true
    });
  }
  return sha;
}

async function createTree(
  request: GitHubRequest,
  api: string,
  baseTree: string,
  entries: TreeEntry[],
  paths: string[]
): Promise<string> {
  const response = await request(`${api}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTree, tree: entries }
  });
  if (response.status === 422) {
    // The usual cause is deleting a path the tree does not contain. Say what
    // GitHub said rather than a cryptic upstream failure.
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `GitHub refused this set of changes: ${githubMessage(response.json) ?? 'invalid tree'}.`,
      details: { paths }
    });
  }
  if (response.status !== 201) throw githubError(response, 'tree create');
  const sha = readField(response.json, 'sha');
  if (sha === null) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: 'GitHub created a tree without returning its SHA.',
      retryable: true
    });
  }
  return sha;
}

async function createCommit(
  request: GitHubRequest,
  api: string,
  message: string,
  tree: string,
  parent: string
): Promise<string> {
  const response = await request(`${api}/git/commits`, {
    method: 'POST',
    body: { message, tree, parents: [parent] }
  });
  if (response.status !== 201) throw githubError(response, 'commit create');
  const sha = readField(response.json, 'sha');
  if (sha === null) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: 'GitHub created a commit without returning its SHA.',
      retryable: true
    });
  }
  // A commit with no ref pointing at it is unreachable, so nothing is durable
  // until the ref update below succeeds. Never report this SHA on its own.
  return sha;
}

/**
 * The head of `branch`, creating it from the tip of `baseBranch` when it is not
 * there. A chat never names a ref; the first write to a change is what mints it.
 */
async function resolveHead(
  request: GitHubRequest,
  api: string,
  branch: string,
  baseBranch: string
): Promise<string> {
  const existing = await readRef(request, api, branch);
  if (existing !== null) return existing;

  const base = await readRef(request, api, baseBranch);
  if (base === null) {
    throw new ForgeError({
      code: 'FORGE_NOT_FOUND',
      message: `${baseBranch} does not exist, so there is nothing to branch ${branch} from.`,
      details: { branch, baseBranch }
    });
  }

  const created = await request(`${api}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: base }
  });
  if (created.status === 201) {
    const sha = readSha(created.json);
    if (sha === null) {
      throw new ForgeError({
        code: 'FORGE_UPSTREAM_UNAVAILABLE',
        message: `GitHub created ${branch} without returning the commit it points at.`,
        retryable: true
      });
    }
    return sha;
  }
  // 422 usually means a concurrent caller created it first. Read what they made
  // rather than assuming it is what we asked for.
  if (created.status === 422) {
    const raced = await readRef(request, api, branch);
    if (raced !== null) return raced;
  }
  throw githubError(created, `creation of ${branch}`);
}

async function readRef(request: GitHubRequest, api: string, branch: string): Promise<string | null> {
  const response = await request(`${api}/git/ref/heads/${encodePath(branch)}`);
  if (response.status === 404) return null;
  if (response.status === 409) {
    // GitHub answers 409 for every ref in a repository with no commits.
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message:
        `This repository has no commits yet, so there is no branch to write onto. ` +
        `It must be created with an initial commit before Forge can write to it.`,
      details: { branch }
    });
  }
  if (response.status !== 200) throw githubError(response, `read of branch ${branch}`);
  const sha = readSha(response.json);
  if (sha === null) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `GitHub returned ${branch} without a commit SHA.`,
      retryable: true
    });
  }
  return sha;
}

/**
 * Refuse to re-apply over a path a concurrent commit changed. This is the line
 * between "the branch moved, carry on" and "someone else's work would vanish".
 */
async function assertNoOverlap(
  request: GitHubRequest,
  api: string,
  from: string,
  to: string,
  paths: string[]
): Promise<void> {
  const response = await request(`${api}/compare/${from}...${to}`);
  if (response.status !== 200) throw githubError(response, 'compare');
  const body = response.json as { files?: Array<{ filename?: unknown }> };
  const files = body.files ?? [];

  if (files.length >= COMPARE_FILE_CAP) {
    throw new ForgeError({
      code: 'FORGE_CONFLICT',
      message:
        `${to.slice(0, 7)} changed too many files for GitHub to list in full, so Forge cannot prove this ` +
        `write would not overwrite one of them. Nothing was committed. Read the change and write again.`,
      details: { paths, from, to }
    });
  }

  const changed = new Set(
    files.map((file) => file.filename).filter((name): name is string => typeof name === 'string')
  );
  const collisions = paths.filter((path) => changed.has(path));
  if (collisions.length > 0) {
    throw new ForgeError({
      code: 'FORGE_CONFLICT',
      message:
        `The branch moved and these paths changed underneath this write: ${collisions.join(', ')}. ` +
        `Nothing was committed. Read them again and reapply — Forge will not overwrite someone else's change.`,
      details: { paths: collisions, from, to }
    });
  }
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function receipt(
  repo: RepoRef,
  branch: string,
  sha: string,
  outcome: 'committed' | 'unchanged',
  paths: string[]
): CommitReceipt {
  return {
    repo: formatRepo(repo),
    branch,
    sha,
    url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    outcome,
    paths
  };
}

/** Branch names contain slashes (`forge/pricing-section`), which must survive. */
function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function readField(json: unknown, field: string): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const value = (json as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readSha(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const object = (json as { object?: unknown }).object;
  return readField(object, 'sha');
}

function githubMessage(json: unknown): string | null {
  return readField(json, 'message');
}

/**
 * Map a GitHub failure onto something the model can act on. Never invent a
 * cause: an unrecognised status says only what happened.
 */
function githubError(response: GitHubResponse, what: string): ForgeError {
  const detail = githubMessage(response.json);
  const said = detail ? `: ${detail}` : '.';
  const status = response.status;

  if (status === 401) {
    return new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message: `GitHub rejected the ${what} as unauthenticated${said}`
    });
  }
  if (status === 403) {
    // A spent rate limit reads as 403 too, and it is retryable while a missing
    // permission is not. The header is the only thing that distinguishes them.
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = response.headers.get('x-ratelimit-reset');
      return new ForgeError({
        code: 'FORGE_UPSTREAM_UNAVAILABLE',
        message: `Your GitHub rate limit is spent, so the ${what} was refused. It resets shortly.`,
        retryable: true,
        details: { resetAt: reset }
      });
    }
    return new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message: `Your GitHub installation does not permit the ${what}${said}`
    });
  }
  if (status === 404) {
    return new ForgeError({
      code: 'FORGE_NOT_FOUND',
      message: `GitHub has no such thing for the ${what}${said}`
    });
  }
  if (status === 422) {
    return new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `GitHub refused the ${what}${said}`
    });
  }
  return new ForgeError({
    code: 'FORGE_UPSTREAM_UNAVAILABLE',
    message: `GitHub failed the ${what} with HTTP ${status}${said}`,
    retryable: status === 429 || status >= 500
  });
}
