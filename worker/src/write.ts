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
 * state to misdescribe. An edit is durable only after the ref update is confirmed;
 * an uncertain update must be inspected before another write.
 *
 * Concurrency is Forge's problem, not the caller's. GitHub already refuses a
 * non-fast-forward ref update; that refusal is the whole concurrency design.
 * We never force, we re-apply onto the new head, and we raise a conflict rather
 * than overwrite a path someone else touched.
 */

import { formatRepo } from './contracts';
import type { CommitReceipt, FileWrite, GitHubRequest, RepoRef } from './contracts';
import { CHANGE_BRANCH } from './change';
import { ForgeError, toForgeError } from './errors';
import { containsHighSeveritySecret } from './content-safety';
import { parseSelector, selectSource } from './selectors';
import { validateSource } from './structure';
import { requireSha } from './evidence';

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
const WRITE_RESPONSE_BUDGET_MS = 55_000;
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

/** New text files are regular; existing file modes come from the exact Git tree. */
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
  validateWriteInput(message, files);

  const api = `/repos/${repo.owner}/${repo.name}`;
  const paths = files.map((file) => file.path);
  const deadline = Date.now() + WRITE_BUDGET_MS;
  const responseDeadline = deadline - WRITE_BUDGET_MS + WRITE_RESPONSE_BUDGET_MS;

  const branchCreation: { outcome: 'none' | 'uncertain' | 'created'; sha: string | null } = { outcome: 'none', sha: null };
  let detachedObjects = false;
  const budgetError = (stage: string): ForgeError =>
    new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message:
        `GitHub was too slow to finish this write (${stage}), so it was stopped before attaching file changes to ${branch}. ` +
        (detachedObjects ? 'GitHub may retain unattached blobs, trees or commits from this attempt. ' : '') +
        'The requested file changes were not applied to the branch.',
      retryable: true,
      details: { branch, paths, stage }
    });
  const checkBudget = (stage: string): void => {
    if (Date.now() >= deadline) throw budgetError(stage);
  };

  // Abort the whole request, including its response body, at the remaining
  // deadline. Racing also bounds request implementations that ignore abort.
  const beforeRef: GitHubRequest = async (path, init) => {
    const stage = `${init?.method ?? 'GET'} ${path}`;
    checkBudget(stage);
    const controller = new AbortController();
    const creatingBranch = init?.method === 'POST' && path === `${api}/git/refs`;
    if (creatingBranch) branchCreation.outcome = 'uncertain';
    if (init?.method === 'POST' && ['/git/blobs', '/git/trees', '/git/commits'].some((suffix) => path.endsWith(suffix))) detachedObjects = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(budgetError(stage));
        }, Math.max(0, deadline - Date.now()));
      });
      const response = await Promise.race([request(path, { ...init, signal: controller.signal }), timeout]);
      if (creatingBranch) {
        if (response.status === 201) {
          branchCreation.outcome = 'created';
          branchCreation.sha = readSha(response.json);
        } else if (response.status >= 400 && response.status < 500) branchCreation.outcome = 'none';
      }
      checkBudget(stage);
      return response;
    } catch (error) {
      if (controller.signal.aborted || Date.now() >= deadline) throw budgetError(stage);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // The head we resolve every fragment edit against. Reading content at this
    // exact SHA — not at the branch name — means a branch that moves mid-write
    // cannot make us apply a fragment to a file we never saw.
    const original = await resolveHead(beforeRef, repo, api, branch, baseBranch);
    const notes: string[] = [];
    const resolved = await resolveContents(beforeRef, api, original, files);

    // Secret checks run against the exact candidate content produced from the
    // current GitHub head. This catches secrets introduced by fragment edits
    // without putting an optional semantic service on the durable write path.
    assertNoHighSeveritySecrets(resolved);
    const unsupported: string[] = [];
    for (const file of resolved) {
      if (file.content === null) continue;
      const validation = validateSource(file.path, file.content);
      if (!validation.supported) unsupported.push(file.path);
    }
    if (unsupported.length) notes.push(`Syntax validation is unsupported for: ${unsupported.join(', ')}. No parser substitute was used; this is not test or typecheck evidence.`);
    checkBudget('checking the resolved content');

    // Blobs are content-addressed, so they are identical however many times the
    // ref update is rejected: create them once, in parallel, outside the loop.
    // An abandoned attempt may leave unattached Git objects, never file changes
    // on the branch. There is no automatic cleanup to race other writers.
    const blobs = await createBlobs(beforeRef, api, resolved);

    const entries: TreeEntry[] = resolved.map((file) => ({
      path: file.path,
      mode: BLOB_MODE,
      type: 'blob',
      sha: blobs.get(file.path) ?? null
    }));

    let head = original;
    let lastRejection: string | null = null;

    for (let attempt = 1; ; attempt += 1) {
      const baseTree = await readCommitTree(beforeRef, api, head);

      // The branch moved under us. Re-applying is only safe for paths nobody else
      // touched: a concurrent commit to a path this write also writes is a real
      // conflict, not a race we are entitled to win by being second.
      if (head !== original) {
        await assertNoOverlap(beforeRef, api, original, head, paths);
      }

      const modes = await readFileModes(beforeRef, api, baseTree, resolved.filter((file) => file.content !== null).map((file) => file.path));
      const preservedEntries = entries.map((entry) => ({ ...entry, mode: modes.get(entry.path) ?? BLOB_MODE }));
      const tree = await createTree(beforeRef, api, baseTree, preservedEntries, paths);

      // Identical tree: the content already matched. No commit, and say so.
      if (tree === baseTree) {
        return receipt(repo, branch, head, 'unchanged', paths, notes);
      }

      const commit = await createCommit(beforeRef, api, message, tree, head);

      checkBudget('updating the branch');
      const uncertainUpdate = (message: string): ForgeError => new ForgeError({
        code: 'FORGE_UPSTREAM_UNAVAILABLE',
        message: `${message} The update to ${branch} may have taken effect. Candidate commit: https://github.com/${formatRepo(repo)}/commit/${commit}. Read the branch before writing again.`,
        retryable: false,
        details: { branch, paths, sha: commit, url: `https://github.com/${formatRepo(repo)}/commit/${commit}`, refUpdate: 'uncertain' }
      });
      let update: GitHubResponse;
      const updateController = new AbortController();
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The transport still needs a finite result after dispatch. Its later
        // deadline returns uncertainty, never a claim that GitHub stayed put.
        const timeout = new Promise<never>((_, reject) => {
          updateTimer = setTimeout(() => { updateController.abort(); reject(uncertainUpdate('GitHub did not confirm the update inside the response budget.')); }, Math.max(0, responseDeadline - Date.now()));
        });
        update = await Promise.race([request(`${api}/git/refs/heads/${encodePath(branch)}`, {
          method: 'PATCH',
          // force:false is the entire lock. GitHub arbitrates; Forge never wins by
          // overwriting.
          body: { sha: commit, force: false },
          signal: updateController.signal
        }), timeout]);
      } catch {
        throw uncertainUpdate('GitHub did not confirm the branch update.');
      } finally {
        clearTimeout(updateTimer);
      }

      if (update.status === 200) {
        // The PATCH response IS the post-update ref, so this is origin's own
        // account of where the branch points — no second read, which would only
        // add latency and a chance of hitting a stale replica.
        const landed = readSha(update.json);
        if (landed !== commit) {
          throw uncertainUpdate(`GitHub accepted the update but reports ${landed ?? 'an unknown commit'}, not ${commit}.`);
        }
        return receipt(repo, branch, commit, 'committed', paths, notes);
      }

      // 422 is GitHub's non-fast-forward: the branch moved between our read and
      // our write. Anything else is a real failure and must not be retried.
      if (update.status !== 422) {
        const error = githubError(update, `update of ${branch}`);
        const uncertain = uncertainUpdate(error.message);
        throw new ForgeError({
          code: error.code,
          message: uncertain.message,
          retryable: false,
          details: { ...uncertain.details, status: update.status }
        });
      }
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

      const moved = await readRef(beforeRef, api, branch);
      if (moved === null) {
        throw new ForgeError({
          code: 'FORGE_NOT_FOUND',
          message: `${branch} was deleted while this write was in flight. Nothing was committed.`,
          details: { branch }
        });
      }
      head = moved;
    }
  } catch (thrown) {
    if (branchCreation.outcome === 'none') throw thrown;
    const error = toForgeError(thrown);
    throw new ForgeError({
      code: error.code,
      message: (branchCreation.outcome === 'created'
        ? `Created ${branch}${branchCreation.sha ? ` at ${branchCreation.sha}` : ' without a returned commit SHA'} before the requested write failed. `
        : `Creation of ${branch} was requested, but its outcome is not confirmed. `) +
        `Inspect https://github.com/${formatRepo(repo)}/tree/${encodePath(branch)} before another write. ${error.message}`,
      retryable: false,
      details: { ...error.details, branchCreation: { branch, sha: branchCreation.sha, outcome: branchCreation.outcome } }
    });
  }
}

// ---------------------------------------------------------------------------
// Validation — refusals that happen before anything touches GitHub
// ---------------------------------------------------------------------------

export function validateWriteInput(message: string, files: FileWrite[]): void {
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
    const operations = Number(writesContent) + Number(replacements.length > 0) + Number(file.edit !== undefined);
    if (operations > 1) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: `${file.path} has both whole-file content and fragment replacements. Send one or the other.`,
        details: { path: file.path }
      });
    }
    if (operations === 0) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: `${file.path} has nothing to write: send content (or null to delete it), or replacements.`,
        details: { path: file.path }
      });
    }

    if (file.edit) {
      requireSha(file.edit.expectedCommit);
      if (parseSelector(file.edit.selector).path !== file.path) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The edit selector must identify the same file as its write entry.' });
      bytes += byteLength(file.edit.replacement);
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

function assertNoHighSeveritySecrets(files: ResolvedFile[]): void {
  for (const file of files) {
    const text = file.content;
    if (!text) continue;
    if (!containsHighSeveritySecret(text)) continue;
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `Commit rejected: ${file.path} contains what appears to be an unredacted secret token or private key.`,
      details: { path: file.path }
    });
  }
}

async function resolveContents(
  request: GitHubRequest,
  api: string,
  head: string,
  files: FileWrite[]
): Promise<ResolvedFile[]> {
  return Promise.all(
    files.map(async (file): Promise<ResolvedFile> => {
      if (file.edit) {
        if (file.edit.expectedCommit !== head) throw new ForgeError({ code: 'FORGE_CONFLICT', message: `${file.path} was selected at a different revision. Read the current proposal source before editing; no range was guessed.` });
        const selector = parseSelector(file.edit.selector);
        if (!selector.selection && !selector.lines) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Source-addressed edits require an explicit symbol, record or line range, not a whole-file selector.' });
        const current = await readTextFile(request, api, file.path, head);
        const selected = selectSource(selector, current);
        return { path: file.path, content: current.slice(0, selected.range.start) + file.edit.replacement + current.slice(selected.range.end) };
      }
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

export function applyReplacements(
  path: string,
  current: string,
  replacements: Array<{ old: string; new: string; all?: boolean }>
): string {
  let next = current;
  for (const replacement of replacements) {
    if (replacement.all === true) {
      if (next.indexOf(replacement.old) === -1) {
        throw new ForgeError({
          code: 'FORGE_VALIDATION_FAILED',
          message:
            `That text is absent from ${path}: ${preview(replacement.old)}. ` +
            `Read the file again — it is not what you expected.`,
          details: { path, reason: 'absent' }
        });
      }
      next = next.split(replacement.old).join(replacement.new);
      continue;
    }

    const first = next.indexOf(replacement.old);
    if (first !== -1) {
      if (next.indexOf(replacement.old, first + 1) !== -1) {
        throw new ForgeError({
          code: 'FORGE_VALIDATION_FAILED',
          message:
            `That text appears more than once in ${path}: ${preview(replacement.old)}. ` +
            `Include enough surrounding context to identify one occurrence, or set all:true to change every one.`,
          details: { path, reason: 'repeated' }
        });
      }
      next = `${next.slice(0, first)}${replacement.new}${next.slice(first + replacement.old.length)}`;
      continue;
    }

    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message:
        `That text is absent from ${path}: ${preview(replacement.old)}. ` +
        `Read the file again — it is not what you expected.`,
      details: { path, reason: 'absent' }
    });
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
  if (response.status !== 200) throw githubError(response, `metadata read of ${path}`);
  const body = response.json as { type?: string; size?: number } | null;
  if (!body || body.type !== 'file' || typeof body.size !== 'number') {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `${path} exists but GitHub did not return regular-file metadata for it, so Forge will not replace it wholesale.`,
      details: { path }
    });
  }
  return body.size;
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

/** Traverse exact non-recursive trees so large repository truncation cannot hide a file mode. */
async function readFileModes(request: GitHubRequest, api: string, root: string, paths: string[]): Promise<Map<string, string>> {
  type Entry = { path: string; mode: string; type: string; sha: string };
  const trees = new Map<string, Promise<Entry[]>>();
  const load = (sha: string): Promise<Entry[]> => {
    const cached = trees.get(sha);
    if (cached) return cached;
    const reading = (async () => {
      const response = await request(`${api}/git/trees/${sha}`);
      if (response.status !== 200) throw githubError(response, 'file mode read');
      const body = response.json as { tree?: unknown; truncated?: unknown } | null;
      if (!Array.isArray(body?.tree) || body?.truncated === true || body.tree.some((entry) => !isRecord(entry) || typeof entry.path !== 'string' || typeof entry.mode !== 'string' || typeof entry.type !== 'string' || typeof entry.sha !== 'string')) throw new ForgeError({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: 'GitHub did not provide complete file-mode evidence. Nothing was committed.' });
      return body.tree as Entry[];
    })();
    trees.set(sha, reading);
    return reading;
  };
  const result = new Map<string, string>();
  await Promise.all(paths.map(async (path) => {
    const segments = path.split('/');
    let tree = root;
    for (let index = 0; index < segments.length; index += 1) {
      const entry = (await load(tree)).find((entry) => entry.path === segments[index]);
      if (!entry) return;
      if (index < segments.length - 1) {
        if (entry.type !== 'tree') throw new ForgeError({ code: 'FORGE_CONFLICT', message: `${path} has a parent that is not a directory.` });
        tree = entry.sha;
      } else {
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `${path} is not a regular file; Forge will not replace a symlink or submodule.` });
        result.set(path, entry.mode);
      }
    }
  }));
  return result;
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
  repo: RepoRef,
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

  const create = () =>
    request(`${api}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: base }
    });

  const created = await create();
  if (created.status === 201) return createdSha(created, branch);
  if (created.status !== 422) throw githubError(created, `creation of ${branch}`);

  // A 422 is either a concurrent caller that created this branch first, or a
  // legacy `forge/<name>` ref making this exact name impossible — a ref cannot
  // be both a branch and a directory. Only now, on the refusal, is it worth
  // asking which; the ordinary create stays a single request.
  const raced = await readRef(request, api, branch);
  if (raced !== null) return raced;

  await refuseLegacyChangeRefs(request, repo, api, branch, baseBranch);
  throw githubError(created, `creation of ${branch}`);
}

function createdSha(response: GitHubResponse, branch: string): string {
  const sha = readSha(response.json);
  if (sha === null) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `GitHub created ${branch} without returning the commit it points at.`,
      retryable: true
    });
  }
  return sha;
}

/** Branches under this prefix are the old Forge naming scheme. */
const LEGACY_BRANCH_PREFIX = 'forge/';

/**
 * A git ref cannot be both a branch and a directory, so while any legacy
 * `forge/<name>` ref exists GitHub refuses to create the fixed `forge` branch —
 * with a bare 422 "Reference update failed" that reads like a validation
 * problem rather than a name clash, and leaves the whole review workflow dead.
 *
 * GitHub offers no expected-head deletion. Even an apparently unused branch
 * can gain real work after a comparison, so only deliberate human recovery
 * may clear the conflicting names.
 */
async function refuseLegacyChangeRefs(
  request: GitHubRequest,
  repo: RepoRef,
  api: string,
  branch: string,
  baseBranch: string
): Promise<void> {
  if (branch !== CHANGE_BRANCH) return;

  const listed = await request(`${api}/git/matching-refs/heads/${encodePath(CHANGE_BRANCH)}`);
  if (listed.status === 404) return;
  if (listed.status !== 200) throw githubError(listed, `check for older ${CHANGE_BRANCH}/ branches`);
  if (!Array.isArray(listed.json)) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `GitHub returned an unreadable list of ${LEGACY_BRANCH_PREFIX} branches.`,
      retryable: true
    });
  }

  const names = listed.json
    .map((entry) => (isRecord(entry) && typeof entry.ref === 'string' ? entry.ref : ''))
    .filter((ref) => ref.startsWith(`refs/heads/${LEGACY_BRANCH_PREFIX}`))
    .map((ref) => ref.slice('refs/heads/'.length));

  if (names.length > 0) {
    throw new ForgeError({
      code: 'FORGE_CONFLICT',
      message:
        `${formatRepo(repo)} has older Forge branches ${names.join(', ')} that prevent the fixed ${CHANGE_BRANCH} branch from existing. ` +
        `Forge left them untouched because deleting even an apparently unused branch can lose a concurrent push. ` +
        `Inspect these branches in GitHub, preserve any work by merging or renaming them, then deliberately remove any remaining conflicting names before writing this change again.`,
      details: { branches: names, baseBranch }
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (typeof response.json !== 'object' || response.json === null || Array.isArray(response.json)) {
    throw new ForgeError({
      code: 'FORGE_CONFLICT',
      message:
        'The branch moved, but GitHub returned unreadable comparison evidence. Nothing was committed. ' +
        'Read the changed paths again and retry; Forge will not guess that there is no overlap.',
      details: { paths, from, to }
    });
  }
  const body = response.json as { files?: unknown };
  if (!Array.isArray(body.files) || body.files.some((file) => !isRecord(file) || typeof file.filename !== 'string' || (file.previous_filename !== undefined && typeof file.previous_filename !== 'string'))) {
    throw new ForgeError({
      code: 'FORGE_CONFLICT',
      message:
        'The branch moved, but GitHub did not return a readable changed-file list. Nothing was committed. ' +
        'Read the changed paths again and retry; Forge will not guess that there is no overlap.',
      details: { paths, from, to }
    });
  }
  const files = body.files as Array<{ filename?: unknown; previous_filename?: unknown }>;

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
    files.flatMap((file) => [file.filename, file.previous_filename]).filter((name): name is string => typeof name === 'string')
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
  paths: string[],
  notes: string[] = []
): CommitReceipt {
  return {
    repo: formatRepo(repo),
    branch,
    sha,
    url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    outcome,
    paths,
    ...(notes.length > 0 ? { notes } : {})
  };
}

/** Keep separators in legacy branch names when the GitHub API receives the path. */
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
