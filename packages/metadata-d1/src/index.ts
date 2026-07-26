import type {
  ProjectId,
  TenantId,
  Workspace,
  WorkspaceId
} from '@forge/core';
import type {
  RepositoryRef,
  Task,
  TaskId,
  TaskState,
  TaskStore
} from '@forge/task-core';

export interface MetadataStore {
  putWorkspace(workspace: Workspace): Promise<void>;
  getWorkspace(id: WorkspaceId): Promise<Workspace | null>;
}

interface WorkspaceRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  project_id: string;
  repository: string;
  requested_ref: string;
  base_commit: string | null;
  initial_head_commit: string | null;
  credential_profile_id: string | null;
  state: string;
  persistence_mode: string;
  runtime_profile: string;
  provider_kind: string;
  provider_version: string;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  current_commit: string | null;
  last_pushed_commit: string | null;
  last_pushed_branch: string | null;
  current_branch: string | null;
  idle_deadline: string | null;
  active_snapshot_id: string | null;
  has_unpushed_work: number | null;
}

export class D1MetadataStore implements MetadataStore {
  constructor(private readonly db: D1Database) {}

  async putWorkspace(workspace: Workspace): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO workspaces (
          id, tenant_id, project_id, repository, requested_ref, base_commit, initial_head_commit, credential_profile_id, state,
          persistence_mode, runtime_profile, provider_kind, provider_version,
          revision, created_by, created_at, updated_at, current_commit,
          current_branch, last_pushed_commit, last_pushed_branch, idle_deadline,
          active_snapshot_id, has_unpushed_work
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          base_commit = excluded.base_commit,
          initial_head_commit = excluded.initial_head_commit,
          credential_profile_id = excluded.credential_profile_id,
          persistence_mode = excluded.persistence_mode,
          revision = excluded.revision,
          updated_at = excluded.updated_at,
          current_commit = excluded.current_commit,
          current_branch = excluded.current_branch,
          last_pushed_commit = excluded.last_pushed_commit,
          last_pushed_branch = excluded.last_pushed_branch,
          idle_deadline = excluded.idle_deadline,
          active_snapshot_id = excluded.active_snapshot_id,
          has_unpushed_work = excluded.has_unpushed_work
      `)
      .bind(
        workspace.id,
        workspace.tenantId,
        workspace.projectId,
        `${workspace.repository.owner}/${workspace.repository.name}`,
        workspace.requestedRef,
        workspace.baseCommit ?? null,
        workspace.initialHeadCommit ?? null,
        workspace.credentialProfileId ?? null,
        workspace.state,
        workspace.persistenceMode,
        workspace.runtimeProfile,
        workspace.provider.kind,
        workspace.provider.version,
        workspace.revision,
        JSON.stringify(workspace.createdBy),
        workspace.createdAt,
        workspace.updatedAt,
        workspace.currentCommit ?? null,
        workspace.currentBranch ?? null,
        workspace.lastPushedCommit ?? null,
        workspace.lastPushedBranch ?? null,
        workspace.idleDeadline ?? null,
        workspace.activeSnapshotId ?? null,
        workspace.hasUnpushedWork ? 1 : 0
      )
      .run();
  }

  async getWorkspace(id: WorkspaceId): Promise<Workspace | null> {
    const row = await this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .bind(id)
      .first<WorkspaceRow>();
    if (!row) return null;
    const separator = row.repository.indexOf('/');
    const owner = separator >= 0 ? row.repository.slice(0, separator) : '';
    const name = separator >= 0 ? row.repository.slice(separator + 1) : '';
    return {
      id: row.id as WorkspaceId,
      tenantId: row.tenant_id as TenantId,
      projectId: row.project_id as ProjectId,
      repository: { provider: 'github', owner, name },
      requestedRef: row.requested_ref,
      ...(row.base_commit ? { baseCommit: row.base_commit } : {}),
      ...(row.initial_head_commit ? { initialHeadCommit: row.initial_head_commit } : {}),
      ...(row.credential_profile_id ? { credentialProfileId: row.credential_profile_id as Workspace['credentialProfileId'] } : {}),
      state: row.state as Workspace['state'],
      persistenceMode: row.persistence_mode as Workspace['persistenceMode'],
      runtimeProfile: row.runtime_profile,
      provider: {
        kind: row.provider_kind as Workspace['provider']['kind'],
        version: row.provider_version
      },
      revision: Number(row.revision),
      createdBy: JSON.parse(row.created_by) as Workspace['createdBy'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.current_commit ? { currentCommit: row.current_commit } : {}),
      ...(row.current_branch ? { currentBranch: row.current_branch } : {}),
      ...(row.last_pushed_commit ? { lastPushedCommit: row.last_pushed_commit } : {}),
      ...(row.last_pushed_branch ? { lastPushedBranch: row.last_pushed_branch } : {}),
      hasUnpushedWork: Boolean(row.has_unpushed_work),
      ...(row.idle_deadline ? { idleDeadline: row.idle_deadline } : {}),
      ...(row.active_snapshot_id
        ? { activeSnapshotId: row.active_snapshot_id as Workspace['activeSnapshotId'] }
        : {})
    };
  }
}

/**
 * Single-use store for capability-token nonces. Backs the replay protection in
 * `verifyCapability`: the first `claim` of a nonce wins, every subsequent claim
 * of the same nonce returns false so a captured token cannot be redeemed twice.
 */
export class D1CapabilityNonceStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Records `nonce` as consumed. Returns true if it was previously unseen, false
   * if it had already been claimed. Relies on the PRIMARY KEY conflict being a
   * no-op so the check-and-set is atomic within D1.
   */
  async claim(nonce: string, action: string, expiresAt: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO capability_nonces (nonce, action, expires_at, seen_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(nonce) DO NOTHING`
      )
      .bind(nonce, action, expiresAt, new Date().toISOString())
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Deletes rows whose capability has already expired. Safe to run anytime. */
  async pruneExpired(now: string = new Date().toISOString()): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM capability_nonces WHERE expires_at <= ?1')
      .bind(now)
      .run();
    return result.meta?.changes ?? 0;
  }
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  project_id: string;
  repository: string;
  base_ref: string;
  goal: string;
  state: string;
  branch: string | null;
  workspace_id: string | null;
  preview_id: string | null;
  latest_diff_hash: string | null;
  revision: number;
  document: string;
  created_at: string;
  updated_at: string;
}

/**
 * The portion of a Task held outside the promoted columns. Kept as bounded JSON
 * so resume-relevant context survives without a wide schema. Never holds
 * secrets, full source, complete logs or raw diffs.
 */
type TaskDocument = Pick<
  Task,
  | 'decisions'
  | 'nonGoals'
  | 'likelyPaths'
  | 'filesRead'
  | 'processIds'
  | 'browserSessionIds'
  | 'changedFiles'
  | 'checks'
  | 'evidenceIds'
  | 'outstanding'
  | 'pushedAt'
  | 'handoff'
>;

function parseRepository(value: string): RepositoryRef {
  const separator = value.indexOf('/');
  const owner = separator >= 0 ? value.slice(0, separator) : '';
  const name = separator >= 0 ? value.slice(separator + 1) : '';
  return { provider: 'github', owner, name };
}

export class D1TaskStore implements TaskStore {
  constructor(private readonly db: D1Database) {}

  async put(task: Task): Promise<void> {
    const document: TaskDocument = {
      decisions: task.decisions,
      nonGoals: task.nonGoals,
      likelyPaths: task.likelyPaths,
      filesRead: task.filesRead,
      processIds: task.processIds,
      browserSessionIds: task.browserSessionIds,
      changedFiles: task.changedFiles,
      checks: task.checks,
      evidenceIds: task.evidenceIds,
      outstanding: task.outstanding,
      pushedAt: task.pushedAt,
      handoff: task.handoff
    };
    await this.db
      .prepare(`
        INSERT INTO tasks (
          id, tenant_id, project_id, repository, base_ref, goal, state, branch,
          workspace_id, preview_id, latest_diff_hash, revision, document,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          goal = excluded.goal,
          state = excluded.state,
          branch = excluded.branch,
          workspace_id = excluded.workspace_id,
          preview_id = excluded.preview_id,
          latest_diff_hash = excluded.latest_diff_hash,
          revision = excluded.revision,
          document = excluded.document,
          updated_at = excluded.updated_at
      `)
      .bind(
        task.id,
        task.tenantId,
        task.projectId,
        `${task.repository.owner}/${task.repository.name}`,
        task.baseRef,
        task.goal,
        task.state,
        task.branch ?? null,
        task.workspaceId ?? null,
        task.previewId ?? null,
        task.latestDiffHash ?? null,
        task.revision,
        JSON.stringify(document),
        task.createdAt,
        task.updatedAt
      )
      .run();
  }

  private static hydrate(row: TaskRow): Task {
    const document = JSON.parse(row.document) as TaskDocument;
    return {
      id: row.id as TaskId,
      tenantId: row.tenant_id as TenantId,
      projectId: row.project_id as ProjectId,
      repository: parseRepository(row.repository),
      baseRef: row.base_ref,
      goal: row.goal,
      decisions: document.decisions,
      nonGoals: document.nonGoals,
      likelyPaths: document.likelyPaths,
      filesRead: document.filesRead,
      processIds: document.processIds,
      browserSessionIds: document.browserSessionIds,
      changedFiles: document.changedFiles,
      checks: document.checks,
      evidenceIds: document.evidenceIds,
      outstanding: document.outstanding,
      ...(document.pushedAt ? { pushedAt: document.pushedAt } : {}),
      ...(document.handoff ? { handoff: document.handoff } : {}),
      state: row.state as TaskState,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.branch ? { branch: row.branch } : {}),
      ...(row.workspace_id ? { workspaceId: row.workspace_id as Task['workspaceId'] } : {}),
      ...(row.preview_id ? { previewId: row.preview_id as Task['previewId'] } : {}),
      ...(row.latest_diff_hash ? { latestDiffHash: row.latest_diff_hash } : {})
    };
  }

  async get(id: TaskId): Promise<Task | null> {
    const row = await this.db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>();
    return row ? D1TaskStore.hydrate(row) : null;
  }

  async list(tenantId: TenantId, opts?: { state?: TaskState; q?: string; limit?: number }): Promise<Task[]> {
    const limit = opts?.limit ?? 50;
    // Tenant scope is always the first clause; state and free-text filters are
    // optional, and every value is a bound parameter (no interpolation). The
    // `q` filter is a recall-oriented LIKE over the goal, repository, and the
    // task document JSON (which carries changed files, decisions, outstanding
    // work) — it can match JSON key names, which is acceptable for a filter.
    const clauses = ['tenant_id = ?'];
    const binds: (string | number)[] = [tenantId];
    if (opts?.state) { clauses.push('state = ?'); binds.push(opts.state); }
    if (opts?.q) { clauses.push('(goal LIKE ? OR repository LIKE ? OR document LIKE ?)'); const like = `%${opts.q}%`; binds.push(like, like, like); }
    binds.push(limit);
    const { results } = await this.db
      .prepare(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
      .bind(...binds)
      .all<TaskRow>();
    return results.map((row) => D1TaskStore.hydrate(row));
  }

  /**
   * Most-recently-updated task attached to a workspace, if any. Used to
   * record push/verification bookkeeping (e.g. pushedAt) against the task
   * that owns a workspace, since forge_git_push only knows the workspace id.
   */
  async getByWorkspace(workspaceId: string): Promise<Task | null> {
    const row = await this.db
      .prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1')
      .bind(workspaceId)
      .first<TaskRow>();
    return row ? D1TaskStore.hydrate(row) : null;
  }
}
