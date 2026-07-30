import type { CredentialProfileId, TaskId } from '@forge/core';
import type { Task } from '@forge/task-core';

export interface HandlerIdentity extends Record<string, unknown> {
  subject: string;
  tenantId: string;
  projectId: string;
  clientId: string;
}

export interface SessionHandlerDependencies {
  identity(): HandlerIdentity;
  loadTask(taskId: TaskId): Promise<Task>;
  selectedCredentialProfileId(identity: HandlerIdentity): Promise<CredentialProfileId | undefined>;
  reclaimStaleWorkspaceSlots(): Promise<number>;
  recordAudit(
    type: string,
    tenantId: string,
    payload: Record<string, unknown>,
    extra?: { workspaceId?: string }
  ): Promise<void>;
  tryResolveApprovalInline(
    identity: HandlerIdentity,
    approval: { approval_id: string; approval_url: string; expires_at: string; already_approved: boolean },
    reason: string
  ): Promise<string | null>;
  runApprovedPullRequestMutation<TReceipt extends Record<string, unknown>>(args: {
    identity: HandlerIdentity;
    owner: string;
    repo: string;
    number: number;
    action: 'close' | 'merge';
    idempotencyKey?: string;
    intent: Record<string, unknown>;
    approvalPayload: Record<string, unknown>;
    approvalId?: string;
    execute: () => Promise<TReceipt>;
  }): Promise<TReceipt | (TReceipt & { replayed: true })>;
  ctx: unknown;
}

export type TaskHandlerDependencies = Pick<SessionHandlerDependencies, 'identity' | 'loadTask' | 'recordAudit'>;
export type ReviewArtifactHandlerDependencies = Pick<SessionHandlerDependencies, 'identity'>;
export type RepositoryWorkspaceHandlerDependencies = Pick<
  SessionHandlerDependencies,
  'identity' | 'selectedCredentialProfileId' | 'reclaimStaleWorkspaceSlots' | 'recordAudit' |
  'runApprovedPullRequestMutation' | 'ctx'
>;
export type ExecutionHandlerDependencies = Pick<
  SessionHandlerDependencies,
  'identity' | 'recordAudit' | 'tryResolveApprovalInline'
>;
