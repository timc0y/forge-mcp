import type { ProjectId, SnapshotId, TenantId, WorkspaceId } from './ids';

export type WorkspaceLifecycleState =
  | 'requested'
  | 'provisioning'
  | 'bootstrapping'
  | 'ready'
  | 'busy'
  | 'suspending'
  | 'suspended'
  | 'restoring'
  | 'failed'
  | 'destroying'
  | 'destroyed';

export type PersistenceMode = 'ephemeral' | 'snapshot_on_idle' | 'persistent';
export type ActorRef =
  | { type: 'user'; id: string }
  | { type: 'agent'; id: string; provider?: string; model?: string }
  | { type: 'service'; id: string }
  | { type: 'github_app'; installationId: string };

export interface RepositoryRef {
  provider: 'github';
  owner: string;
  name: string;
}

export interface SandboxProviderRef {
  kind: 'cloudflare' | 'local-docker';
  version: string;
}

export interface Workspace {
  id: WorkspaceId;
  tenantId: TenantId;
  projectId: ProjectId;
  repository: RepositoryRef;
  requestedRef: string;
  currentCommit?: string;
  currentBranch?: string;
  state: WorkspaceLifecycleState;
  persistenceMode: PersistenceMode;
  runtimeProfile: string;
  provider: SandboxProviderRef;
  revision: number;
  createdBy: ActorRef;
  createdAt: string;
  updatedAt: string;
  idleDeadline?: string;
  activeSnapshotId?: SnapshotId;
  failure?: {
    stage: string;
    code: string;
    message: string;
    retryable: boolean;
    details?: WorkspaceFailureDetails;
  };
  checkout?: { healthy: boolean; checkedAt: string; detail?: string };
}

// Kept structured-clone serializable so it survives the Durable Object RPC
// boundary in forge_workspace_get (a Record<string, unknown> would collapse the
// stub return type to never).
export type WorkspaceFailureDetails = Record<
  string,
  string | number | boolean | null | string[]
>;

export interface WorkspaceMutationInput {
  workspaceId: WorkspaceId;
  expectedRevision?: number;
  idempotencyKey: string;
}

export interface WorkspaceMutationResult<T> {
  value: T;
  workspaceRevision: number;
  operationId: string;
}
