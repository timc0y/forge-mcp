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
 * Both post-approval steps are plain GitHub REST calls made with the installation
 * token, which is why neither needs the workspace to still exist.
 */

type DeferredActionState =
  | 'awaiting_approval'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'expired';

export interface DeferredAction {
  id: string;
  tenantId: string;
  projectId: string;
  workspaceId: string;
  approvalId: string;
  taskId: string | null;
  action: 'work.submit';
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
  state: DeferredActionState;
  result: { pr_number: number; pr_url: string } | null;
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
    state: row.state as DeferredActionState,
    result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createDeferredAction(
  env: Env,
  input: Omit<DeferredAction, 'id' | 'state' | 'result' | 'error' | 'createdAt' | 'updatedAt'>
): Promise<DeferredAction> {
  const id = ids.deferred();
  const now = new Date().toISOString();
  await env.METADATA.prepare(
    `INSERT INTO deferred_actions
      (id, tenant_id, project_id, workspace_id, approval_id, task_id, action,
       repo_owner, repo_name, branch, base, staged_ref, commit_sha, title, body,
       summary, files_changed, github_repository_id, state, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?19,'awaiting_approval',?18,?18)`
  ).bind(
    id, input.tenantId, input.projectId, input.workspaceId, input.approvalId,
    input.taskId, input.action, input.repository.owner, input.repository.name,
    input.branch, input.base, input.stagedRef, input.commitSha, input.title,
    input.body, input.summary, input.filesChanged, now, input.githubRepositoryId ?? null
  ).run();
  return {
    ...input,
    id,
    state: 'awaiting_approval',
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now
  };
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
  const error = 'Timed out while opening the pull request. Approve again to retry.';
  await setState(env, action.id, 'failed', { error });
  return { ...action, state: 'failed', error, updatedAt: new Date().toISOString() };
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

async function setState(
  env: Env,
  id: string,
  state: DeferredActionState,
  fields: { result?: DeferredAction['result']; error?: string | null } = {}
): Promise<void> {
  await env.METADATA.prepare(
    'UPDATE deferred_actions SET state=?1, result=?2, error=?3, updated_at=?4 WHERE id=?5'
  ).bind(
    state,
    fields.result === undefined ? null : JSON.stringify(fields.result),
    fields.error ?? null,
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
  await setState(env, id, 'denied', { error: 'Declined by the reviewer.' });
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
}

export async function executeDeferredAction(
  env: Env,
  action: DeferredAction,
  executors: DeferredExecutors
): Promise<DeferredAction> {
  if (action.state === 'completed') return action;
  const claimed = await env.METADATA.prepare(
    "UPDATE deferred_actions SET state='executing', updated_at=?1 WHERE id=?2 AND state IN ('awaiting_approval','failed')"
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
    const result = { pr_number: pr.number, pr_url: pr.url };
    await setState(env, action.id, 'completed', { result });
    return { ...action, state: 'completed', result };
  } catch (error) {
    const message = error instanceof ForgeError
      ? error.message
      : error instanceof Error ? error.message.slice(0, 500) : 'unknown error';
    await setState(env, action.id, 'failed', { error: message });
    return { ...action, state: 'failed', error: message };
  }
}
