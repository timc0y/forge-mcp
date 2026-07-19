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
          id, tenant_id, project_id, repository, requested_ref, state,
          persistence_mode, runtime_profile, provider_kind, provider_version,
          revision, created_by, created_at, updated_at, current_commit,
          current_branch, idle_deadline, active_snapshot_id, has_unpushed_work
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          persistence_mode = excluded.persistence_mode,
          revision = excluded.revision,
          updated_at = excluded.updated_at,
          current_commit = excluded.current_commit,
          current_branch = excluded.current_branch,
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
      hasUnpushedWork: Boolean(row.has_unpushed_work),
      ...(row.idle_deadline ? { idleDeadline: row.idle_deadline } : {}),
      ...(row.active_snapshot_id
        ? { activeSnapshotId: row.active_snapshot_id as Workspace['activeSnapshotId'] }
        : {})
    };
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
      outstanding: task.outstanding
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

  async list(tenantId: TenantId, opts?: { state?: TaskState; limit?: number }): Promise<Task[]> {
    const limit = opts?.limit ?? 50;
    const query = opts?.state
      ? this.db
          .prepare('SELECT * FROM tasks WHERE tenant_id = ? AND state = ? ORDER BY updated_at DESC LIMIT ?')
          .bind(tenantId, opts.state, limit)
      : this.db
          .prepare('SELECT * FROM tasks WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?')
          .bind(tenantId, limit);
    const { results } = await query.all<TaskRow>();
    return results.map((row) => D1TaskStore.hydrate(row));
  }
}
