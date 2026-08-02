import { describe, expect, it, vi } from 'vitest';
import {
  createDeferredAction,
  denyDeferredAction,
  executeDeferredAction,
  getDeferredActionByApproval,
  listPendingDeferredActions,
  rebindDeferredApproval,
  recoverStaleExecutingDeferred,
  type DeferredExecutors
} from '../../apps/forge-edge-gateway/src/deferred-actions';
import type { Env } from '../../apps/forge-edge-gateway/src/env';

type Row = Record<string, unknown>;

// Minimal in-memory D1 understanding only the statements deferred-actions.ts
// issues. Matching on SQL fragments keeps it honest: a query this fake does not
// recognise throws rather than silently returning nothing.
// Current state of the repositories table, so a test can rename an owner
// underneath a queued submission.
const repositories: Array<{ tenant_id: string; github_repository_id: string; owner: string; name: string }> = [];

function fakeD1(rows: Row[]) {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM repositories')) {
            return (repositories.find(
              (repo) => repo.tenant_id === values[0] && repo.github_repository_id === values[1]
            ) as T) ?? null;
          }
          if (sql.includes('WHERE approval_id=?1 AND tenant_id=?2')) {
            return (rows.find((row) => row.approval_id === values[0] && row.tenant_id === values[1]) as T) ?? null;
          }
          if (sql.includes('WHERE id=?1')) {
            return (rows.find((row) => row.id === values[0]) as T) ?? null;
          }
          throw new Error(`unexpected first(): ${sql}`);
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("state IN ('awaiting_approval','executing','failed')")) {
            return {
              results: rows.filter(
                (row) => row.tenant_id === values[0] &&
                  ['awaiting_approval', 'executing', 'failed'].includes(String(row.state))
              ) as T[]
            };
          }
          if (sql.includes('AND workspace_id=?2')) {
            return { results: rows.filter((row) => row.tenant_id === values[0] && row.workspace_id === values[1]) as T[] };
          }
          throw new Error(`unexpected all(): ${sql}`);
        },
        async run(): Promise<{ meta: { changes: number } }> {
          if (sql.startsWith('INSERT INTO deferred_actions')) {
            const [id, tenant_id, project_id, workspace_id, approval_id, task_id, action,
              repo_owner, repo_name, branch, base, staged_ref, commit_sha, title, body,
              summary, files_changed, now, github_repository_id] = values;
            rows.push({
              id, tenant_id, project_id, workspace_id, approval_id, task_id, action,
              repo_owner, repo_name, branch, base, staged_ref, commit_sha, title, body,
              summary, files_changed, github_repository_id,
              state: 'awaiting_approval', result: null, error: null,
              created_at: now, updated_at: now
            });
            return { meta: { changes: 1 } };
          }
          // The optimistic claim: only transitions a row that is still unclaimed.
          if (sql.includes("SET state='executing'")) {
            const row = rows.find((candidate) => candidate.id === values[1]);
            if (!row || !['awaiting_approval', 'failed'].includes(String(row.state))) {
              return { meta: { changes: 0 } };
            }
            row.state = 'executing';
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET state=?1, result=?2, error=?3')) {
            const row = rows.find((candidate) => candidate.id === values[4]);
            if (!row) return { meta: { changes: 0 } };
            row.state = values[0];
            row.result = values[1];
            row.error = values[2];
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET approval_id=?1')) {
            const row = rows.find((candidate) => candidate.id === values[2]);
            if (!row || !['awaiting_approval', 'failed'].includes(String(row.state))) {
              return { meta: { changes: 0 } };
            }
            row.approval_id = values[0];
            row.updated_at = values[1];
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run(): ${sql}`);
        }
      };
      return statement;
    }
  };
}

function envWith(rows: Row[]): Env {
  repositories.length = 0;
  repositories.push({ tenant_id: 'ten_a', github_repository_id: '4242', owner: 'acme', name: 'app' });
  return { METADATA: fakeD1(rows) } as unknown as Env;
}

const submission = {
  tenantId: 'ten_a',
  projectId: 'prj_a',
  workspaceId: 'ws_a',
  approvalId: 'apr_a',
  taskId: null,
  action: 'work.submit' as const,
  repository: { provider: 'github' as const, owner: 'acme', name: 'app' },
  githubRepositoryId: '4242',
  branch: 'forge/fix-login',
  base: 'main',
  stagedRef: 'forge/staged/ws_a/fix-login',
  commitSha: 'a'.repeat(40),
  title: 'Fix login',
  body: 'Body',
  summary: '2 files changed',
  filesChanged: 2
};

function executors(overrides: Partial<DeferredExecutors> = {}): DeferredExecutors {
  return {
    promoteStagedRef: vi.fn(async () => undefined),
    createDraftPullRequest: vi.fn(async () => ({ number: 7, url: 'https://github.com/acme/app/pull/7', state: 'open' })),
    ...overrides
  };
}

describe('deferred actions (async approval)', () => {
  it('parks a submission awaiting approval without doing anything to GitHub', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    const action = await createDeferredAction(env, submission);
    expect(action.state).toBe('awaiting_approval');
    expect(action.result).toBeNull();
    // Nothing has been promoted or opened: the human has not decided yet.
    const stored = await getDeferredActionByApproval(env, 'ten_a', 'apr_a');
    expect(stored?.stagedRef).toBe(submission.stagedRef);
    expect(stored?.state).toBe('awaiting_approval');
  });

  it('pushes the branch and opens the PR when the human finally approves', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    const action = await createDeferredAction(env, submission);
    const deps = executors();
    const result = await executeDeferredAction(env, action, deps);

    expect(result.state).toBe('completed');
    expect(result.result).toEqual({ pr_number: 7, pr_url: 'https://github.com/acme/app/pull/7' });
    // The branch is promoted to the staged commit before the PR is opened —
    // opening a PR for a branch that does not exist yet would fail.
    expect(deps.promoteStagedRef).toHaveBeenCalledWith(
      env,
      { tenantId: 'ten_a', projectId: 'prj_a' },
      submission.repository,
      { branch: 'forge/fix-login', commitSha: submission.commitSha }
    );
    expect(deps.createDraftPullRequest).toHaveBeenCalledWith(
      env,
      { tenantId: 'ten_a', projectId: 'prj_a' },
      submission.repository,
      { head: 'forge/fix-login', base: 'main', title: 'Fix login', body: 'Body' }
    );
  });

  it('does not open two pull requests when approval is submitted twice', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    const action = await createDeferredAction(env, submission);
    const deps = executors();
    const [first, second] = await Promise.all([
      executeDeferredAction(env, action, deps),
      executeDeferredAction(env, action, deps)
    ]);
    expect(deps.createDraftPullRequest).toHaveBeenCalledTimes(1);
    // Both callers see a coherent state, neither sees a second PR.
    for (const outcome of [first, second]) {
      expect(['completed', 'executing']).toContain(outcome.state);
    }
  });

  it('records why a submission failed and keeps the staged commits', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    const action = await createDeferredAction(env, submission);
    const deps = executors({
      promoteStagedRef: vi.fn(async () => {
        throw new Error('forge/fix-login has moved on since this work was staged');
      })
    });
    const result = await executeDeferredAction(env, action, deps);

    expect(result.state).toBe('failed');
    expect(result.error).toContain('moved on');
    expect(deps.createDraftPullRequest).not.toHaveBeenCalled();
    // Still recoverable: the commits are on the staging ref and a retry is allowed.
    const stored = await getDeferredActionByApproval(env, 'ten_a', 'apr_a');
    expect(stored?.stagedRef).toBe(submission.stagedRef);
    const retry = await executeDeferredAction(env, stored!, executors());
    expect(retry.state).toBe('completed');
  });

  it('follows a GitHub rename that happened while it sat in the queue', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    await createDeferredAction(env, submission);
    // The whole point of async approval is that this can be days later — and an
    // owner login is mutable, so the slug captured at submit time can go stale.
    repositories[0]!.owner = 'acme-renamed';

    // Reload from storage, the way the approval page does, so the pinned id has
    // to survive the round-trip rather than being carried in memory.
    const reloaded = await getDeferredActionByApproval(env, 'ten_a', 'apr_a');
    expect(reloaded?.githubRepositoryId).toBe('4242');
    const deps = executors();
    const result = await executeDeferredAction(env, reloaded!, deps);
    expect(result.state).toBe('completed');
    // Both GitHub calls must target the repository as it is NOW, not as it was.
    expect(deps.promoteStagedRef).toHaveBeenCalledWith(
      env, expect.anything(),
      { provider: 'github', owner: 'acme-renamed', name: 'app' },
      expect.anything()
    );
    expect(deps.createDraftPullRequest).toHaveBeenCalledWith(
      env, expect.anything(),
      { provider: 'github', owner: 'acme-renamed', name: 'app' },
      expect.anything()
    );
  });

  it('falls back to the stored slug when the immutable id is unknown', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    const action = await createDeferredAction(env, { ...submission, githubRepositoryId: null });
    const deps = executors();
    expect((await executeDeferredAction(env, action, deps)).state).toBe('completed');
    expect(deps.promoteStagedRef).toHaveBeenCalledWith(
      env, expect.anything(), submission.repository, expect.anything()
    );
  });

  it('declining pushes nothing', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    const action = await createDeferredAction(env, submission);
    await denyDeferredAction(env, action.id);
    const stored = await getDeferredActionByApproval(env, 'ten_a', 'apr_a');
    expect(stored?.state).toBe('denied');
    expect(stored?.result).toBeNull();
  });

  it('lists what is still waiting on the human, and drops what is settled', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    const first = await createDeferredAction(env, submission);
    await createDeferredAction(env, { ...submission, approvalId: 'apr_b', branch: 'forge/other' });

    expect(await listPendingDeferredActions(env, 'ten_a')).toHaveLength(2);
    await executeDeferredAction(env, first, executors());
    const remaining = await listPendingDeferredActions(env, 'ten_a');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.branch).toBe('forge/other');
  });

  it('scopes reads to the owning tenant', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    await createDeferredAction(env, submission);
    expect(await getDeferredActionByApproval(env, 'ten_other', 'apr_a')).toBeNull();
    expect(await listPendingDeferredActions(env, 'ten_other')).toHaveLength(0);
  });

  it('rebinds an awaiting submission onto a fresh approval id', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    const action = await createDeferredAction(env, submission);
    await rebindDeferredApproval(env, action.id, 'apr_fresh');
    const stored = await getDeferredActionByApproval(env, 'ten_a', 'apr_fresh');
    expect(stored?.id).toBe(action.id);
    expect(stored?.approvalId).toBe('apr_fresh');
    expect(await getDeferredActionByApproval(env, 'ten_a', 'apr_a')).toBeNull();
  });

  it('flips stale executing rows to failed so the portal can retry', async () => {
    const rows: Row[] = [];
    const env = envWith(rows);
    const action = await createDeferredAction(env, submission);
    const stuck = rows.find((row) => row.id === action.id)!;
    stuck.state = 'executing';
    stuck.updated_at = new Date(Date.now() - 11 * 60_000).toISOString();
    const recovered = await recoverStaleExecutingDeferred(env, {
      ...action,
      state: 'executing',
      updatedAt: String(stuck.updated_at)
    });
    expect(recovered.state).toBe('failed');
    expect(recovered.error).toContain('Timed out');
    expect(stuck.state).toBe('failed');
  });
});
