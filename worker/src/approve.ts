/**
 * The two acts a human must authorize: landing a change on the default branch,
 * and throwing one away. Everything else in Forge is either reversible or
 * additive; these two are not, so they are the only things that stop here.
 *
 * The shape of this file is the whole lesson of `30800bc`: approval used to be
 * synchronous, and a tool threw FORGE_APPROVAL_REQUIRED that only the *same*
 * live conversation could redeem. That made "I'll look at that later" — the
 * natural shape of a review decision — into an interrupt, and any chat that
 * ended, summarised, or dropped an identifier lost the pending act entirely.
 *
 * So: one URL, openable on any device, days later, by a human who no longer has
 * the chat. The evidence the model saw is copied into the row at request time,
 * because an approval whose evidence is re-fetched at click time asks the human
 * to judge something other than what was proposed. And the act is performed
 * SERVER-SIDE at the moment of the decision — there is no agent left to redeem
 * anything.
 *
 * What deliberately does not exist here: capability tokens, tenants, deferred
 * action rows, retry state machines. One table, one URL, one HMAC.
 */

import type {
  ApprovalAct,
  ApprovalReceipt,
  ApprovalRequest,
  Change,
  ChangedFile,
  Comparison,
  GitHubRequest,
  Identity
} from './contracts';
import { formatRepo } from './contracts';
import type { Env } from './env';
import { ForgeError } from './errors';
import { analyticsFor } from './analytics';
import { escapeHtml, page } from './ui';

/**
 * Long enough that a link mailed to yourself on a Friday still works, short
 * enough that a leaked URL is not a standing grant. The row is authoritative;
 * the token carries no expiry of its own, so shortening this is a one-word
 * change with no re-issued tokens to chase.
 */
const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'failed';

type ApprovalRow = {
  id: string;
  user_id: string;
  act: ApprovalAct;
  repo_owner: string;
  repo_name: string;
  branch: string;
  head_sha: string;
  evidence_json: string;
  state: ApprovalState;
  result_json: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
};

/**
 * Exactly what the model saw when it asked. Frozen at request time: re-deriving
 * it at click time would show the human a different change from the one that was
 * proposed, which is the failure this whole file exists to prevent.
 */
interface Evidence {
  change: Change;
  comparison: Comparison;
}

/** What actually happened, written once, read by every later click. */
interface Outcome {
  decision: 'approve' | 'reject';
  ok: boolean;
  /** One plain sentence for a human. Stored unescaped; escaped at render. */
  detail: string;
  /** The pull request or commit to look at, when there is one. */
  url?: string;
  sha?: string;
}

// ---------------------------------------------------------------------------
// 1. Request
// ---------------------------------------------------------------------------

/**
 * Persist a pending approval and hand back the one URL that can resolve it.
 *
 * Returns as soon as the row is durable. Nothing polls, nothing is held open,
 * and the caller may report the work finished the moment this resolves — the
 * URL is the whole continuation.
 */
export async function requestApproval(
  env: Env,
  identity: Identity,
  req: ApprovalRequest
): Promise<ApprovalReceipt> {
  // Refuse to manufacture a decision that cannot be carried out, or that would
  // carry out nothing. A human asked to authorize theatre stops reading these
  // pages, and a page that reads them stops being a control.
  if (req.act === 'merge') {
    if (req.change.number === null) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: `Change "${req.change.name}" has no open pull request, so there is nothing to merge. Write to the change first.`,
        details: { change: req.change.name }
      });
    }
    if (req.comparison.aheadBy === 0) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: `Change "${req.change.name}" has no commits the default branch does not already have. There is nothing to merge.`,
        details: { change: req.change.name, status: req.comparison.status }
      });
    }
  }

  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
  const evidence: Evidence = { change: req.change, comparison: req.comparison };

  await env.METADATA.prepare(
    `INSERT INTO approvals
       (id, user_id, act, repo_owner, repo_name, branch, head_sha, evidence_json, state, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10)`
  )
    .bind(
      id,
      identity.userId,
      req.act,
      req.repo.owner,
      req.repo.name,
      req.change.branch,
      req.headSha,
      JSON.stringify(evidence),
      now.toISOString(),
      expiresAt.toISOString()
    )
    .run();

  const token = await signApprovalToken(env, id);
  return {
    act: req.act,
    url: `${origin(env)}/approvals/${id}?t=${encodeURIComponent(token)}`,
    expiresAt: expiresAt.toISOString(),
    summary: summarize(req)
  };
}

/**
 * Size is read off the comparison, never off the change. A `Change` carries
 * stats only when something measured them, and an approval must never show a
 * number that was assumed.
 */
function comparisonTotals(comparison: Comparison): string {
  const files = comparison.files.length;
  const additions = comparison.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = comparison.files.reduce((sum, file) => sum + file.deletions, 0);
  const counted = `${files} file${files === 1 ? '' : 's'}, +${additions}/-${deletions}`;
  return comparison.truncated ? `${counted} (GitHub listed only the first 300)` : counted;
}

function summarize(req: ApprovalRequest): string {
  const repo = formatRepo(req.repo);
  const totals = comparisonTotals(req.comparison);
  if (req.act === 'merge') {
    return `Approve to merge "${req.change.name}" into ${repo} (${totals}).`;
  }
  return `Approve to discard "${req.change.name}" in ${repo} (${totals}). ${lossStatement(req.comparison)}`;
}

/**
 * The one fact a discard decision turns on. `aheadBy` is the direct measure —
 * commits this change has that the default branch does not — and it is what
 * `Comparison.status` of `identical` or `behind` means in practice.
 */
function lossStatement(comparison: Comparison): string {
  if (comparison.aheadBy === 0) {
    return 'Nothing unmerged is lost: every commit on this change is already on the default branch.';
  }
  const plural = comparison.aheadBy === 1 ? 'commit' : 'commits';
  return `${comparison.aheadBy} ${plural} would stop being reachable.`;
}

// ---------------------------------------------------------------------------
// 2. The page
// ---------------------------------------------------------------------------

/**
 * Render the decision, or — if it is already settled — the outcome.
 *
 * GET only, and it must stay side-effect free apart from the pending→expired
 * sweep below, which takes nothing away that the human could still have had.
 * Link previews, security scanners and browser prefetchers all issue GETs on
 * URLs pasted into a chat; if loading this page could resolve it, the approval
 * would be decided by a crawler.
 */
export async function approvalPage(env: Env, id: string, token: string): Promise<Response> {
  const loaded = await loadApproval(env, id, token);
  if (loaded.kind === 'settled') return loaded.response;
  return renderDecision(loaded.row, loaded.evidence, id, token);
}

// ---------------------------------------------------------------------------
// 3. The decision
// ---------------------------------------------------------------------------

/**
 * Perform the act server-side and record what happened.
 *
 * INVARIANT — the router must only reach this from a POST. Every safety
 * property below assumes a deliberate form submission; nothing here re-checks
 * the HTTP method because it is not given the Request.
 *
 * `request` is an already-authenticated GitHub caller scoped to this user's own
 * installation. This file never builds a client and never sees a token.
 */
export async function resolveApproval(
  env: Env,
  id: string,
  token: string,
  decision: 'approve' | 'reject',
  request: GitHubRequest,
  waitUntil?: (promise: Promise<unknown>) => void
): Promise<Response> {
  const loaded = await loadApproval(env, id, token);
  if (loaded.kind === 'settled') return loaded.response;
  const { row, evidence } = loaded;
  const track = analyticsFor(env, row.user_id, waitUntil);

  // Claim the row BEFORE touching GitHub. A conditional update on state is the
  // only lock this system has, and it is enough: two simultaneous clicks race
  // to change one row, exactly one wins, and the loser falls through to reading
  // the outcome. Acting first and recording after would let a double-click
  // merge twice, or delete a branch whose deletion was already recorded.
  const nowIso = new Date().toISOString();
  const claim = await env.METADATA.prepare(
    `UPDATE approvals SET state = ?1, resolved_at = ?2 WHERE id = ?3 AND state = 'pending'`
  )
    .bind(decision === 'approve' ? 'approved' : 'rejected', nowIso, id)
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    // Someone (or another tab) got there first. Show them what happened.
    const settled = await loadApproval(env, id, token);
    if (settled.kind === 'settled') return settled.response;
    return problem(500, 'Could not record that decision', 'Nothing was changed. Reload this page.');
  }

  if (decision === 'reject') {
    const outcome: Outcome = {
      decision: 'reject',
      ok: true,
      detail:
        row.act === 'merge'
          ? 'Not merged. The change is untouched and still open, so it can be merged later or discarded.'
          : 'Not discarded. The change is untouched and still open.'
    };
    await recordOutcome(env, id, 'rejected', outcome);
    track('approval_resolved', { act: row.act, decision: 'reject', ok: true });
    return renderOutcome(row, evidence, 'rejected', outcome);
  }

  const outcome =
    row.act === 'merge'
      ? await performMerge(request, row, evidence)
      : await performDiscard(request, row, evidence);

  // A refusal or an upstream failure is recorded as `failed`, never rolled back
  // to `pending`. Re-arming the button would invite a human to click through a
  // refusal they did not understand; a fresh approval, with fresh evidence, is
  // the honest way to try again.
  const state: ApprovalState = outcome.ok ? 'approved' : 'failed';
  await recordOutcome(env, id, state, outcome);
  track('approval_resolved', { act: row.act, decision: 'approve', ok: outcome.ok });
  return renderOutcome(row, evidence, state, outcome);
}

async function recordOutcome(env: Env, id: string, state: ApprovalState, outcome: Outcome): Promise<void> {
  await env.METADATA.prepare(
    `UPDATE approvals SET state = ?1, result_json = ?2, resolved_at = ?3 WHERE id = ?4`
  )
    .bind(state, JSON.stringify(outcome), new Date().toISOString(), id)
    .run();
}

// ---------------------------------------------------------------------------
// The acts themselves
// ---------------------------------------------------------------------------

async function performMerge(
  request: GitHubRequest,
  row: ApprovalRow,
  evidence: Evidence
): Promise<Outcome> {
  const number = evidence.change.number;
  if (number === null) {
    return { decision: 'approve', ok: false, detail: 'This change no longer has a pull request to merge.' };
  }
  const response = await request(
    `/repos/${row.repo_owner}/${row.repo_name}/pulls/${number}/merge`,
    {
      method: 'PUT',
      // `sha` is the entire point: GitHub compares it against the branch head and
      // returns 409 if anything was pushed since. Without it the human's decision
      // would apply to whatever happens to be on the branch at click time, which
      // — days after the fact — is not what they read on this page.
      // No `merge_method`: the default preserves the change's commits, and a
      // squash/rebase choice is a preference nobody has asked for.
      body: { sha: row.head_sha }
    }
  );

  if (response.status === 409) {
    return {
      decision: 'approve',
      ok: false,
      detail: `Refused: the change moved since this approval was created. Nothing was merged, because ${short(row.head_sha)} is no longer the head of ${row.branch}. Ask for a fresh approval so you can see what changed.`
    };
  }
  if (response.status === 405) {
    return {
      decision: 'approve',
      ok: false,
      detail: `Refused by GitHub: this pull request is not mergeable${suffix(messageOf(response.json))} Nothing was merged.`
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      decision: 'approve',
      ok: false,
      detail: `GitHub refused the merge with status ${response.status}${suffix(messageOf(response.json))} Nothing was merged.`
    };
  }

  const sha = stringField(response.json, 'sha');
  const merged: Outcome = {
    decision: 'approve',
    ok: true,
    detail: `Merged "${evidence.change.name}" into the default branch of ${row.repo_owner}/${row.repo_name}.`,
    url: `https://github.com/${row.repo_owner}/${row.repo_name}/pull/${number}`
  };
  if (sha !== '') merged.sha = sha;
  return merged;
}

async function performDiscard(
  request: GitHubRequest,
  row: ApprovalRow,
  evidence: Evidence
): Promise<Outcome> {
  const number = evidence.change.number;

  // Refuse to delete a branch that moved after the human was shown what it held.
  //
  // A merge is protected by passing the expected head, which GitHub answers
  // with 409 if it no longer matches. `DELETE /git/refs` accepts no such
  // guard, and an approval link lives for seven days — so without this read,
  // anything committed to the branch between minting and clicking would be
  // destroyed by someone who never saw it. This is still technically
  // time-of-check-to-time-of-use, but it shrinks a week-wide window to the
  // milliseconds between these two calls.
  const current = await request(
    `/repos/${row.repo_owner}/${row.repo_name}/git/ref/heads/${encodePath(row.branch)}`
  );
  if (current.status >= 200 && current.status < 300) {
    const head = (current.json as { object?: { sha?: string } } | null)?.object?.sha;
    if (typeof head === 'string' && head !== row.head_sha) {
      return {
        decision: 'approve',
        ok: false,
        detail:
          `Nothing was discarded. "${evidence.change.name}" has moved since this was ` +
          `requested — it is now at ${short(head)}, not ${short(row.head_sha)}, so it holds work ` +
          'that was not shown here. Look at it again and discard it afresh if you still want to.'
      };
    }
  }
  // A ref that cannot be read is not a reason to stop: 404 means it is already
  // gone, which is the outcome being asked for anyway.

  if (number !== null) {
    const closed = await request(`/repos/${row.repo_owner}/${row.repo_name}/pulls/${number}`, {
      method: 'PATCH',
      body: { state: 'closed' }
    });
    // 404 means it is already gone — that is the state we wanted. Anything else
    // is a real failure, and we stop BEFORE deleting the branch: an API that
    // will not let us close a pull request is not one we should be handing an
    // irreversible ref deletion to.
    const closeOk = (closed.status >= 200 && closed.status < 300) || closed.status === 404;
    if (!closeOk) {
      return {
        decision: 'approve',
        ok: false,
        detail: `Could not close pull request #${number} (status ${closed.status})${suffix(messageOf(closed.json))} The branch was left alone, so nothing was lost.`
      };
    }
  }

  const deleted = await request(
    `/repos/${row.repo_owner}/${row.repo_name}/git/refs/heads/${encodePath(row.branch)}`,
    { method: 'DELETE' }
  );
  // 404/422 both mean the ref is not there. A second click, a branch deleted by
  // hand on github.com, and a successful first attempt all land here and all
  // mean the same thing: the change is gone. That is what idempotent means for
  // a deletion.
  const deleteOk =
    (deleted.status >= 200 && deleted.status < 300) || deleted.status === 404 || deleted.status === 422;
  if (!deleteOk) {
    return {
      decision: 'approve',
      ok: false,
      detail: `${number === null ? 'Nothing was closed' : `Pull request #${number} was closed`}, but branch ${row.branch} could not be deleted (status ${deleted.status})${suffix(messageOf(deleted.json))}`
    };
  }

  return {
    decision: 'approve',
    ok: true,
    detail: `Discarded "${evidence.change.name}": ${number === null ? 'the branch was deleted' : `pull request #${number} is closed and the branch was deleted`}. ${lossStatement(evidence.comparison)}`
  };
}

// ---------------------------------------------------------------------------
// Loading, and every reason not to proceed
// ---------------------------------------------------------------------------

type Loaded =
  | { kind: 'ready'; row: ApprovalRow; evidence: Evidence }
  | { kind: 'settled'; response: Response };

/**
 * The single gate. Both entry points go through it, so a rule cannot hold on the
 * page and be missing on the POST.
 */
async function loadApproval(env: Env, id: string, token: string): Promise<Loaded> {
  const expected = await signApprovalToken(env, id);
  // Verify the signature before the lookup. The token proves the id came from
  // us, so an unsigned id never reaches the database at all.
  if (!constantTimeEqual(token, expected)) return { kind: 'settled', response: notValid() };

  const row = await env.METADATA.prepare(
    `SELECT id, user_id, act, repo_owner, repo_name, branch, head_sha, evidence_json,
            state, result_json, created_at, expires_at, resolved_at
       FROM approvals WHERE id = ?1`
  )
    .bind(id)
    .first<ApprovalRow>();
  // A wrong token and a nonexistent id render the same page on purpose: this URL
  // must not tell a stranger whether an approval exists.
  if (!row) return { kind: 'settled', response: notValid() };

  let evidence: Evidence;
  try {
    evidence = JSON.parse(row.evidence_json) as Evidence;
  } catch {
    return {
      kind: 'settled',
      response: problem(
        500,
        'This approval cannot be shown',
        'The record of what was proposed could not be read, so there is nothing to judge. Nothing was done. Ask for the action again.'
      )
    };
  }

  if (row.state !== 'pending') {
    const outcome = parseOutcome(row.result_json);
    return { kind: 'settled', response: renderOutcome(row, evidence, row.state, outcome) };
  }

  if (Date.parse(row.expires_at) <= Date.now()) {
    // Recorded so the row stops appearing as something a human could still act
    // on. This is the one write a GET may perform, and it takes nothing away.
    await env.METADATA.prepare(`UPDATE approvals SET state = 'expired' WHERE id = ?1 AND state = 'pending'`)
      .bind(id)
      .run();
    return { kind: 'settled', response: renderOutcome(row, evidence, 'expired', null) };
  }

  return { kind: 'ready', row, evidence };
}

function parseOutcome(value: string | null): Outcome | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as Outcome;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 over the approval id alone. The id is a random UUID and the row
 * holds state and expiry, so there is nothing else worth binding into the token
 * — and a token with no claims cannot be replayed into meaning something else.
 */
async function signApprovalToken(env: Env, id: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.FORGE_SIGNING_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id));
  return base64Url(signature);
}

/**
 * Compare without leaking where the mismatch is. A byte-at-a-time early return
 * turns a 32-byte secret into 32 independent one-byte guesses.
 *
 * Length is not secret here (every token is the same length), so returning
 * early on a length mismatch reveals nothing an attacker cannot already see.
 */
function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function base64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index] ?? 0);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------


/**
 * No external CSS, script, font or image — partly so the page renders in an
 * offline in-app browser on a phone, and partly because every subresource is a
 * third party who would learn this URL. `Canvas`/`CanvasText` are the reader's
 * own system colours, which is a whole theme system for free.
 */
function shell(status: number, title: string, body: string): Response {
  return page({
    status,
    title,
    body,
    headers: {
      // The URL is the credential. Never cache it, never send it in a Referer
      // header, never let it be framed, and never let it load anything.
      'cache-control': 'no-store, private',
      'x-robots-tag': 'noindex, nofollow',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  });
}

function problem(status: number, heading: string, detail: string): Response {
  return shell(
    status,
    `Forge — ${heading}`,
    `<h1>${escapeHtml(heading)}</h1><div class="box"><p>${escapeHtml(detail)}</p></div>`
  );
}

function notValid(): Response {
  return problem(
    404,
    'This approval link is not valid',
    'It may have been mistyped, or it may belong to an approval that no longer exists. Nothing was changed. Ask for the action again to get a fresh link.'
  );
}

function renderDecision(row: ApprovalRow, evidence: Evidence, id: string, token: string): Response {
  const merge = row.act === 'merge';
  const heading = merge ? 'Merge this change?' : 'Discard this change?';
  // Relative, so the POST always returns to the origin the human actually
  // loaded — no cross-origin bounce, and `form-action 'self'` holds.
  const action = `/approvals/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;

  const consequence = merge
    ? `<p>Approving puts these commits on the default branch of <strong>${escapeHtml(formatRepoRow(row))}</strong>. Forge does the merge itself when you press the button — nothing is waiting on the conversation that asked.</p>`
    : `<p><strong>${escapeHtml(lossStatement(evidence.comparison))}</strong></p>` +
      `<p>Approving closes the pull request and deletes the branch <code>${escapeHtml(row.branch)}</code>. Deleting a branch cannot be undone from here.</p>`;

  return shell(
    200,
    `Forge — ${heading}`,
    `<h1>${escapeHtml(heading)}</h1>` +
      `<p class="lead">${escapeHtml(evidence.change.name)} · ${escapeHtml(formatRepoRow(row))}</p>` +
      `<div class="box">${consequence}</div>` +
      details(row, evidence) +
      fileList(evidence.comparison) +
      `<form method="post" action="${escapeHtml(action)}">` +
      `<button class="${merge ? 'go' : 'danger'}" type="submit" name="decision" value="approve">${merge ? 'Merge it' : 'Discard it'}</button>` +
      `<button type="submit" name="decision" value="reject">Keep it as it is</button>` +
      `</form>` +
      `<p class="note">This link stops working ${escapeHtml(when(row.expires_at))}. Nothing happens until you press a button.</p>`
  );
}

function renderOutcome(
  row: ApprovalRow,
  evidence: Evidence,
  state: ApprovalState,
  outcome: Outcome | null
): Response {
  const act = row.act === 'merge' ? 'Merge' : 'Discard';
  let heading: string;
  let detail: string;
  let tone: string;

  if (state === 'expired') {
    heading = 'This approval has expired';
    detail = `Nothing was done. ${act} approvals last seven days so that a stale link cannot land a change nobody has looked at recently. Ask for the action again and a fresh link will be issued.`;
    tone = 'bad';
  } else if (state === 'rejected') {
    heading = row.act === 'merge' ? 'Not merged' : 'Not discarded';
    detail = outcome?.detail ?? 'You rejected this. Nothing was changed.';
    tone = 'good';
  } else if (state === 'failed') {
    heading = row.act === 'merge' ? 'Not merged' : 'Not discarded';
    detail = outcome?.detail ?? 'The act could not be completed, and nothing was changed.';
    tone = 'bad';
  } else if (outcome === null) {
    // Claimed but not yet recorded — the other tab is mid-flight. Never offer a
    // button here: the act is already under way and must not run twice.
    heading = 'This decision is already recorded';
    detail = 'Forge is carrying it out now. Reload this page in a moment to see the result.';
    tone = 'good';
  } else {
    heading = row.act === 'merge' ? 'Merged' : 'Discarded';
    detail = outcome.detail;
    tone = 'good';
  }

  const link =
    outcome?.url === undefined
      ? ''
      : ` <a href="${escapeHtml(outcome.url)}" rel="noreferrer noopener">Open it on GitHub</a>.`;
  const sha = outcome?.sha === undefined ? '' : `<p class="note">Commit <code>${escapeHtml(short(outcome.sha))}</code></p>`;

  return shell(
    200,
    `Forge — ${heading}`,
    `<h1>${escapeHtml(heading)}</h1>` +
      `<p class="lead">${escapeHtml(evidence.change.name)} · ${escapeHtml(formatRepoRow(row))}</p>` +
      `<div class="box ${tone}"><p>${escapeHtml(detail)}${link}</p>${sha}</div>` +
      details(row, evidence) +
      fileList(evidence.comparison) +
      `<p class="note">Resolved ${escapeHtml(when(row.resolved_at ?? row.expires_at))}. This link no longer does anything; opening it again just shows this page.</p>`
  );
}

function details(row: ApprovalRow, evidence: Evidence): string {
  const change = evidence.change;
  const rows: Array<[string, string]> = [
    ['Act', row.act === 'merge' ? 'Merge onto the default branch' : 'Close and delete the change'],
    ['Repository', formatRepoRow(row)],
    ['Change', change.name],
    ['Branch', row.branch],
    ['Head', short(row.head_sha)],
    ['Size', comparisonTotals(evidence.comparison)],
    ['Commits', `${evidence.comparison.aheadBy} ahead, ${evidence.comparison.behindBy} behind`]
  ];
  return (
    `<dl>` +
    rows
      .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
      .join('') +
    `</dl>`
  );
}

function fileList(comparison: Comparison): string {
  if (comparison.files.length === 0) {
    return `<h2>Files</h2><p class="note">No files differ.</p>`;
  }
  const items = comparison.files.map((file: ChangedFile) =>
    `<li><span class="path">${escapeHtml(file.path)}<br><span class="st">${escapeHtml(file.status)}</span></span>` +
    `<span class="counts"><span class="add">+${escapeHtml(file.additions)}</span> <span class="del">−${escapeHtml(file.deletions)}</span></span></li>`
  );
  // GitHub caps the compare file list. Saying so is mandatory: a human deciding
  // from a list they believe is complete is deciding on evidence they do not have.
  const capped = comparison.truncated
    ? `<p class="note">GitHub capped this list. More files are affected than are shown here.</p>`
    : '';
  return `<h2>Files</h2><ul class="files">${items.join('')}</ul>${capped}`;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function formatRepoRow(row: ApprovalRow): string {
  return formatRepo({ owner: row.repo_owner, name: row.repo_name });
}

function origin(env: Env): string {
  return env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, '');
}

/**
 * Every change branch contains a slash (`forge/pricing-section`), and GitHub's
 * ref endpoints match on the path itself — percent-encoding the separator makes
 * the ref simply not exist. Encode each segment, keep the slashes.
 */
function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** UTC, spelled out. A reviewer may open this in any timezone, days later. */
function when(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 'at an unknown time' : `on ${new Date(parsed).toUTCString()}`;
}

/** GitHub's own explanation, when it gave one, appended as its own sentence. */
function suffix(message: string): string {
  return message === '' ? '.' : `: ${message}`;
}

function messageOf(json: unknown): string {
  return stringField(json, 'message');
}

function stringField(json: unknown, field: string): string {
  if (typeof json !== 'object' || json === null) return '';
  const value = (json as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() : '';
}
