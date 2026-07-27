import type { CredentialProfileId, ProjectId, SnapshotId, TenantId, WorkspaceId } from './ids';

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
  kind: 'cloudflare' | 'local-docker' | 'self-hosted';
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
  lastPushedCommit?: string;
  lastPushedBranch?: string;
  currentBranch?: string;
  // True once local work exists that hasn't been pushed (a forge branch, a
  // commit, an applied patch or file write). The idle reaper refuses to destroy
  // such a workspace so an agent's unpushed work is never silently lost.
  hasUnpushedWork?: boolean;
  /** Set when origin disagrees with workspace HEAD on the feature branch. */
  gitRemoteDivergence?: {
    remoteSha: string;
    localHead: string;
    branch: string;
    detectedAt: string;
  };
  /** Result of a push-authorization probe at workspace create. */
  pushAuthProbe?: {
    ok: boolean;
    checkedAt: string;
    reason?: string;
  };
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
  // Set when checkout recovery (after an idle container recycle wiped
  // /workspace/repo) could only re-clone from the remote, losing local-only
  // commits/edits that were never pushed. Sticky — cleared only by the caller
  // once the loss has been surfaced and acknowledged.
  dataLoss?: { at: string; detail: string };
  // Non-fatal bootstrap issue: the workspace came up `ready` but dependency
  // install did not fully succeed (e.g. a --frozen-lockfile mismatch that the
  // non-frozen fallback also could not resolve). The checkout is usable; deps
  // may need attention before `dev`/`build`.
  bootstrapWarning?: { phase: string; message: string; detail?: string };
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
  /** Why the workspace revision changed, for optimistic concurrency transparency. */
  revisionChange?: {
    from: number;
    to: number;
    reason: 'checkpoint_created' | 'mutation_applied' | 'process_state_changed' | 'state_transition' | 'recovery';
    filesystemChanged: boolean;
    gitChanged: boolean;
    processStateChanged: boolean;
  };
}
