import { ForgeError, ids, type RepositoryRef } from '@forge/core';
import type { Env } from './env';

/**
 * Async approvals.
 *
 * Forge's original approval model was synchronous: a tool threw
 * FORGE_APPROVAL_REQUIRED, and the human had to approve *right then* so the still
 * running agent could retry with the approval id. The authorization was never the
 * expensive part — the blocking was. An agent had to sit alive waiting on a
 * browser click, and a workspace had to stay up with it, for a decision that is
 * naturally asynchronous ("I'll look at that PR later").
 *
 * A deferred action decouples the two. The agent stages its commits on a
 * Forge-owned `forge/staged/…` ref, records here exactly what it wants done, and
 * finishes. The human approves whenever they like — minutes or days later, from
 * the portal — and Forge itself performs the push and opens the pull request,
 * with no live agent and no live workspace involved.
 *
 * Both post-approval paths are plain GitHub REST calls made with the installation
 * token, which is why neither needs the workspace to still exist: submissions
 * promote a staged commit and open a draft PR; merge actions recheck and merge
 * an existing PR.
 */

type DeferredActionState =
  | 'awaiting_approval'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'expired';

export type DeferredMergeMethod = 'merge' | 'squash' | 'rebase';
export type DeferredActionKind = 'work.submit' | 'pull_request.merge';

export interface DeferredAction {
  id: string;
  tenantId: string;
  projectId: string;
  workspaceId: string;
  approvalId: string;
  taskId: string | null;
  action: DeferredActionKind;
  repository: RepositoryRef;
  /** GitHub's immutable numeric repository id, when known. */
  githubRepositoryId: string | null;
  branch: string;
  base: string;
  stagedRef: string;
  commitSha: string;
  title: string;
  body: string;
  summary: string;
  filesChanged: number;
  pullRequestNumber: number | null;
  mergeMethod: DeferredMergeMethod | null;
  /** Stable caller key for a deferred merge, when the caller supplied one. */
  idempotencyKey: string | null;
  /** False means the row needs a fresh public request, not another approval retry. */
  retryable: boolean;
  state: DeferredActionState;
  result: { pr_number: number; pr_url: string; merge_sha?: string } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  tenant_id: string;
  project_id: string;
  workspace_id: string;
  approval_id: string;
  task_id: string | null;
  action: string;
  repo_owner: string;
  repo_name: string;
  github_repository_id: string | null;
  branch: string;
  base: string;
  staged_ref: string;
  commit_sha: string;
  title: string;
  body: string;
  summary: string;
  files_changed: number;
  pull_request_number: number | null;
  merge_method: string | null;
  idempotency_key: string | null;
  retryable: number | null;
  state: string;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function hydrate(row: Row): DeferredAction {
  let result: DeferredAction['result'] = null;
  if (row.result) {
    try {
      result = JSON.parse(row.result) as DeferredAction['result'];
    } catch {
      result = null;
    }
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    approvalId: row.approval_id,
    taskId: row.task_id,
    action: row.action as DeferredAction['action'],
    repository: { provider: 'github', owner: row.repo_owner, name: row.repo_name },
    githubRepositoryId: row.github_repository_id ?? null,
    branch: row.branch,
    base: row.base,
    stagedRef: row.staged_ref,
    commitSha: row.commit_sha,
    title: row.title,
    body: row.body,
    summary: row.summary,
    filesChanged: row.files_changed,
    pullRequestNumber: row.pull_request_number ?? null,
    mergeMethod: row.merge_method === 'merge' || row.merge_method === 'squash' || row.merge_method === 'rebase'
      ? row.merge_method
      : null,
    idempotencyKey: row.idempotency_key ?? null,
    // Rows written before the column was added are retryable by default.
    retryable: row.retryable !== 0,
    state: row.state as DeferredActionState,
    result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createDeferredAction(
  env: Env,
  input: Omit<DeferredAction, 'id' | 'state' | 'result' | 'error' | 'createdAt' | 'updatedAt' | 'pullRequestNumber' | 'mergeMethod' | 'idempotencyKey' | 'retryable'> & {
    pullRequestNumber?: number | null;
    mergeMethod?: DeferredMergeMethod | null;
    idempotencyKey?: string | null;
  }
): Promise<DeferredAction> {
  const id = ids.deferred();
  const now = new Date().toISOString();
  await env.METADATA.prepare(
    `INSERT INTO deferred_actions
      (id, tenant_id, project_id, workspace_id, approval_id, task_id, action,
       repo_owner, repo_name, branch, base, staged_ref, commit_sha, title, body,
       summary, files_changed, github_repository_id, pull_request_number, merge_method,
       idempotency_key, retryable, state, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,1,'awaiting_approval',?22,?22)`
  ).bind(
    id, input.tenantId, input.projectId, input.workspaceId, input.approvalId,
    input.taskId, input.action, input.repository.owner, input.repository.name,
    input.branch, input.base, input.stagedRef, input.commitSha, input.title,
    input.body, input.summary, input.filesChanged, input.githubRepositoryId ?? null,
    input.pullRequestNumber ?? null, input.mergeMethod ?? null, input.idempotencyKey ?? null, now
  ).run();
  return {
    ...input,
    id,
    state: 'awaiting_approval',
    result: null,
    error: null,
    pullRequestNumber: input.pullRequestNumber ?? null,
    mergeMethod: input.mergeMethod ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    retryable: true,
    createdAt: now,
    updatedAt: now
  };
}

export async function createDeferredPullRequestMergeAction(
  env: Env,
  input: {
    tenantId: string;
    projectId: string;
    repository: RepositoryRef;
    githubRepositoryId?: string | null;
    approvalId: string;
    pullRequestNumber: number;
    headRef: string;
    baseRef: string;
    headSha: string;
    title: string;
    body: string;
    mergeMethod: DeferredMergeMethod;
    idempotencyKey?: string | null;
  }
): Promise<DeferredAction> {
  return createDeferredAction(env, {
    tenantId: input.tenantId,
    projectId: input.projectId,
    // A merge never needs a live executor workspace. Keep an addressable scope
    // for the approval row while making the absence of executor state explicit.
    workspaceId: `repository:${input.repository.owner}/${input.repository.name}`,
    approvalId: input.approvalId,
    taskId: null,
    action: 'pull_request.merge',
    repository: input.repository,
    githubRepositoryId: input.githubRepositoryId ?? null,
    branch: input.headRef,
    base: input.baseRef,
    stagedRef: input.headRef,
    commitSha: input.headSha,
    title: input.title,
    body: input.body,
    summary: `Merge pull request #${input.pullRequestNumber}`,
    filesChanged: 0,
    pullRequestNumber: input.pullRequestNumber,
    mergeMethod: input.mergeMethod,
    idempotencyKey: input.idempotencyKey ?? null
  });
}

export async function getDeferredActionByApproval(
  env: Env,
  tenantId: string,
  approvalId: string
): Promise<DeferredAction | null> {
  const row = await env.METADATA.prepare(
    'SELECT * FROM deferred_actions WHERE approval_id=?1 AND tenant_id=?2'
  ).bind(approvalId, tenantId).first<Row>();
  if (!row) return null;
  return recoverStaleExecutingDeferred(env, hydrate(row));
}

/** Everything still waiting on this human, newest first — the portal queue. */
export async function listPendingDeferredActions(
  env: Env,
  tenantId: string,
  limit = 50
): Promise<DeferredAction[]> {
  const result = await env.METADATA.prepare(
    `SELECT * FROM deferred_actions
      WHERE tenant_id=?1 AND state IN ('awaiting_approval','executing','failed')
      ORDER BY created_at DESC LIMIT ?2`
  ).bind(tenantId, limit).all<Row>();
  const actions = (result.results ?? []).map(hydrate);
  // Crash/timeout after claim leaves rows in 'executing' with no worker. Flip
  // those to 'failed' so the portal keeps a real Retry path instead of
  // "opening pull request…" forever.
  return Promise.all(actions.map((action) => recoverStaleExecutingDeferred(env, action)));
}

/** How long a deferred row may sit in 'executing' before we treat it as failed. */
const STALE_EXECUTING_MS = 10 * 60_000;

export async function recoverStaleExecutingDeferred(
  env: Env,
  action: DeferredAction
): Promise<DeferredAction> {
  if (action.state !== 'executing') return action;
  if (Date.now() - Date.parse(action.updatedAt) < STALE_EXECUTING_MS) return action;
  const error = action.action === 'pull_request.merge'
    ? 'Timed out while merging the pull request. Approve again to retry.'
    : 'Timed out while opening the pull request. Approve again to retry.';
  await setState(env, action.id, 'failed', { error, retryable: true });
  return { ...action, state: 'failed', error, retryable: true, updatedAt: new Date().toISOString() };
}

/**
 * Point a queued submission at a freshly minted approval. Used when forge_merge
 * is retried after the linked approval's short sync TTL has lapsed — the staged
 * work is still valid, only the approval row needs replacing.
 */
export async function rebindDeferredApproval(
  env: Env,
  deferredId: string,
  approvalId: string
): Promise<void> {
  await env.METADATA.prepare(
    `UPDATE deferred_actions
        SET approval_id=?1, updated_at=?2
      WHERE id=?3 AND state IN ('awaiting_approval','failed')`
  ).bind(approvalId, new Date().toISOString(), deferredId).run();
}

export async function listDeferredActionsForWorkspace(
  env: Env,
  tenantId: string,
  workspaceId: string
): Promise<DeferredAction[]> {
  const result = await env.METADATA.prepare(
    'SELECT * FROM deferred_actions WHERE tenant_id=?1 AND workspace_id=?2 ORDER BY created_at DESC LIMIT 20'
  ).bind(tenantId, workspaceId).all<Row>();
  return (result.results ?? []).map(hydrate);
}

/** Recover the latest submission by its durable repository/branch address. */
export async function getLatestDeferredActionForBranch(
  env: Env,
  tenantId: string,
  projectId: string,
  repository: { owner: string; name: string },
  branch: string
): Promise<DeferredAction | null> {
  const row = await env.METADATA.prepare(
    `SELECT * FROM deferred_actions
      WHERE tenant_id=?1 AND project_id=?2 AND repo_owner=?3 AND repo_name=?4 AND branch=?5
      ORDER BY created_at DESC LIMIT 1`
  ).bind(tenantId, projectId, repository.owner, repository.name, branch).first<Row>();
  return row ? recoverStaleExecutingDeferred(env, hydrate(row)) : null;
}

/** Recover a merge by the immutable pull-request number, not a mutable branch. */
export async function getLatestDeferredActionForPullRequest(
  env: Env,
  tenantId: string,
  projectId: string,
  repository: { owner: string; name: string },
  pullRequestNumber: number
): Promise<DeferredAction | null> {
  const row = await env.METADATA.prepare(
    `SELECT * FROM deferred_actions
      WHERE tenant_id=?1 AND project_id=?2 AND repo_owner=?3 AND repo_name=?4
        AND action='pull_request.merge' AND pull_request_number=?5
      ORDER BY created_at DESC LIMIT 1`
  ).bind(tenantId, projectId, repository.owner, repository.name, pullRequestNumber).first<Row>();
  return row ? recoverStaleExecutingDeferred(env, hydrate(row)) : null;
}

/** Find the one deferred merge reserved by a caller's stable retry key. */
export async function getDeferredActionByIdempotencyKey(
  env: Env,
  tenantId: string,
  projectId: string,
  repository: { owner: string; name: string },
  idempotencyKey: string
): Promise<DeferredAction | null> {
  const row = await env.METADATA.prepare(
    `SELECT * FROM deferred_actions
      WHERE tenant_id=?1 AND project_id=?2 AND repo_owner=?3 AND repo_name=?4
        AND action='pull_request.merge' AND idempotency_key=?5
      ORDER BY created_at DESC LIMIT 1`
  ).bind(tenantId, projectId, repository.owner, repository.name, idempotencyKey).first<Row>();
  return row ? recoverStaleExecutingDeferred(env, hydrate(row)) : null;
}

async function setState(
  env: Env,
  id: string,
  state: DeferredActionState,
  fields: { result?: DeferredAction['result']; error?: string | null; retryable?: boolean } = {}
): Promise<void> {
  await env.METADATA.prepare(
    'UPDATE deferred_actions SET state=?1, result=?2, error=?3, retryable=?4, updated_at=?5 WHERE id=?6'
  ).bind(
    state,
    fields.result === undefined ? null : JSON.stringify(fields.result),
    fields.error ?? null,
    fields.retryable === false ? 0 : 1,
    new Date().toISOString(),
    id
  ).run();
}

/**
 * The repository's slug as it stands now, not as it stood when the agent
 * submitted. Looked up by GitHub's immutable numeric id; returns the stored
 * owner/name unchanged when that id is unknown or no longer authorized.
 */
async function currentRepositorySlug(env: Env, action: DeferredAction): Promise<RepositoryRef> {
  if (!action.githubRepositoryId) return action.repository;
  const row = await env.METADATA.prepare(
    `SELECT owner, name FROM repositories
      WHERE tenant_id=?1 AND provider='github' AND github_repository_id=?2 AND authorization_state='authorized'
      LIMIT 1`
  ).bind(action.tenantId, action.githubRepositoryId).first<{ owner: string; name: string }>().catch(() => null);
  return row ? { provider: 'github', owner: row.owner, name: row.name } : action.repository;
}

export async function denyDeferredAction(env: Env, id: string): Promise<void> {
  await setState(env, id, 'denied', { error: 'Declined by the reviewer.', retryable: false });
}

/**
 * Perform the work the human just approved: fast-forward the real branch to the
 * staged commit, then open the draft pull request.
 *
 * Claims the row with a conditional state transition first, so two approval-page
 * submissions racing each other (a double-click, a retried POST) cannot open two
 * pull requests for the same submission. A run that fails is left in 'failed'
 * with the reason recorded rather than silently retried — the reviewer sees what
 * broke on the page, and the staged ref still holds the commits.
 */
/**
 * The two GitHub operations an approved submission performs, injected by the
 * caller. Passing them in rather than importing them keeps this module free of a
 * dependency back on `github.ts`, which imports this one to run the executor from
 * the approval page.
 */
export interface DeferredExecutors {
  promoteStagedRef: (
    env: Env,
    identity: { tenantId: string; projectId: string },
    repository: RepositoryRef,
    input: { branch: string; commitSha: string }
  ) => Promise<void>;
  createDraftPullRequest: (
    env: Env,
    identity: { tenantId: string; projectId: string },
    repository: RepositoryRef,
    input: { head: string; base: string; title: string; body: string }
  ) => Promise<{ number: number; url: string; state: string }>;
  mergePullRequest: (
    env: Env,
    identity: { tenantId: string; projectId: string },
    repository: RepositoryRef,
    input: { number: number; expectedHeadSha: string; mergeMethod: DeferredMergeMethod }
  ) => Promise<{ number: number; url: string; mergeSha: string }>;
}

export async function executeDeferredAction(
  env: Env,
  action: DeferredAction,
  executors: DeferredExecutors
): Promise<DeferredAction> {
  if (action.state === 'completed') return action;
  if (action.state === 'failed' && action.retryable === false) return action;
  const claimed = await env.METADATA.prepare(
    "UPDATE deferred_actions SET state='executing', retryable=1, updated_at=?1 WHERE id=?2 AND (state='awaiting_approval' OR (state='failed' AND retryable=1))"
  ).bind(new Date().toISOString(), action.id).run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    const current = await env.METADATA.prepare('SELECT * FROM deferred_actions WHERE id=?1')
      .bind(action.id).first<Row>();
    return current ? hydrate(current) : action;
  }

  try {
    // A submission can sit in the queue for days, and an owner login is mutable —
    // renaming a GitHub account rewrites it on every repository. Re-resolve the
    // slug from the immutable numeric id so an approval that outlives a rename
    // still targets the right repository. Falls back to what was stored when the
    // id is unknown (rows written before it was recorded).
    const repository = await currentRepositorySlug(env, action);
    let result: DeferredAction['result'];
    if (action.action === 'pull_request.merge') {
      if (!action.pullRequestNumber || !action.mergeMethod) {
        throw new ForgeError({
          code: 'FORGE_INTERNAL_ERROR',
          message: 'Deferred pull-request merge is missing its pinned pull request or merge method. Recreate the merge request; do not retry this corrupted action.',
          retryable: false
        });
      }
      const merged = await executors.mergePullRequest(
        env,
        { tenantId: action.tenantId, projectId: action.projectId },
        repository,
        { number: action.pullRequestNumber, expectedHeadSha: action.commitSha, mergeMethod: action.mergeMethod }
      );
      result = { pr_number: merged.number, pr_url: merged.url, merge_sha: merged.mergeSha };
    } else {
      // 1. Promote the staged commit onto the branch the human approved. Creates the
      //    branch if it does not exist, fast-forwards it if it does.
      await executors.promoteStagedRef(
        env,
        { tenantId: action.tenantId, projectId: action.projectId },
        repository,
        { branch: action.branch, commitSha: action.commitSha }
      );
      // 2. Open the draft PR against the base recorded at submit time.
      const pr = await executors.createDraftPullRequest(
        env,
        { tenantId: action.tenantId, projectId: action.projectId },
        repository,
        { head: action.branch, base: action.base, title: action.title, body: action.body }
      );
      result = { pr_number: pr.number, pr_url: pr.url };
    }
    await setState(env, action.id, 'completed', { result, retryable: true });
    return { ...action, state: 'completed', result, retryable: true, updatedAt: new Date().toISOString() };
  } catch (error) {
    const message = error instanceof ForgeError
      ? error.message
      : error instanceof Error ? error.message.slice(0, 500) : 'unknown error';
    const retryable = error instanceof ForgeError ? error.retryable : true;
    await setState(env, action.id, 'failed', { error: message, retryable });
    return { ...action, state: 'failed', error: message, retryable, updatedAt: new Date().toISOString() };
  }
}
