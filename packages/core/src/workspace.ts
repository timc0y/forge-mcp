import type { CredentialProfileId, ProjectId, TenantId, WorkspaceId } from './ids';

export type WorkspaceLifecycleState =
  | 'requested'
  | 'provisioning'
  | 'bootstrapping'
  | 'ready'
  | 'busy'
  | 'failed'
  | 'destroying'
  | 'destroyed';

export type PersistenceMode = 'ephemeral';
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
  kind: 'cloudflare';
  version: string;
}

export interface Workspace {
  id: WorkspaceId;
  tenantId: TenantId;
  projectId: ProjectId;
  repository: RepositoryRef;
  requestedRef: string;
  baseCommit?: string;
  initialHeadCommit?: string;
  credentialProfileId?: CredentialProfileId;
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
  failure?: {
    stage: string;
    code: string;
    message: string;
    retryable: boolean;
    details?: WorkspaceFailureDetails;
  };
  checkout?: { healthy: boolean; checkedAt: string; detail?: string };
  // Non-fatal bootstrap warning: Workspace is `ready` but dependencies failed to install cleanly (e.g., --frozen-lockfile mismatch fallback failed). Checkout is usable, but deps require attention before `dev`/`build`.
  bootstrapWarning?: { phase: string; message: string; detail?: string };
}

// Must remain structured-clone serializable to survive the Durable Object RPC boundary in forge_workspace_get. `Record<string, unknown>` collapses stub return to `never`.
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
  /** Reason for revision change, used for optimistic concurrency transparency. */
  revisionChange?: {
    from: number;
    to: number;
    reason: 'mutation_applied' | 'process_state_changed' | 'state_transition' | 'recovery';
    filesystemChanged: boolean;
    gitChanged: boolean;
    processStateChanged: boolean;
  };
}
