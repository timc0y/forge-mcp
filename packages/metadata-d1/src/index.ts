import type {
  ProjectId,
  TenantId,
  Workspace,
  WorkspaceId
} from '@forge/core';

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
}

export class D1MetadataStore implements MetadataStore {
  constructor(private readonly db: D1Database) {}

  async putWorkspace(workspace: Workspace): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO workspaces (
          id, tenant_id, project_id, repository, requested_ref, credential_profile_id, state,
          persistence_mode, runtime_profile, provider_kind, provider_version,
          revision, created_by, created_at, updated_at, current_commit,
          current_branch, last_pushed_commit, last_pushed_branch, idle_deadline, active_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state = excluded.state,
          credential_profile_id = excluded.credential_profile_id,
          persistence_mode = excluded.persistence_mode,
          revision = excluded.revision,
          updated_at = excluded.updated_at,
          current_commit = excluded.current_commit,
          current_branch = excluded.current_branch,
          last_pushed_commit = excluded.last_pushed_commit,
          last_pushed_branch = excluded.last_pushed_branch,
          idle_deadline = excluded.idle_deadline,
          active_snapshot_id = excluded.active_snapshot_id
      `)
      .bind(
        workspace.id,
        workspace.tenantId,
        workspace.projectId,
        `${workspace.repository.owner}/${workspace.repository.name}`,
        workspace.requestedRef,
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
        workspace.activeSnapshotId ?? null
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
      ...(row.idle_deadline ? { idleDeadline: row.idle_deadline } : {}),
      ...(row.active_snapshot_id
        ? { activeSnapshotId: row.active_snapshot_id as Workspace['activeSnapshotId'] }
        : {})
    };
  }
}
