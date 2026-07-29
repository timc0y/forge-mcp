import type { WorkspaceId } from '@forge/core';

export interface ProvisionWorkspaceParams {
  workspaceId: WorkspaceId;
  bootstrap: boolean;
}

export interface SuspendWorkspaceParams {
  workspaceId: WorkspaceId;
  requestedBy: string;
}

export interface RestoreWorkspaceParams {
  workspaceId: WorkspaceId;
  snapshotId: string;
  restoreIntoNewWorkspace: boolean;
}

export interface DestroyWorkspaceParams {
  workspaceId: WorkspaceId;
  idempotencyKey: string;
  preserveArtifacts: boolean;
  force: boolean;
}

export interface CreatePullRequestParams {
  workspaceId: WorkspaceId;
  approvalId: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export const workflowRetryPolicy = {
  retries: {
    limit: 3,
    delay: '5 seconds' as const,
    backoff: 'exponential' as const
  },
  timeout: '15 minutes' as const
};

export function workflowInstanceId(
  kind: 'provision' | 'suspend' | 'restore' | 'destroy' | 'pull-request',
  workspaceId: WorkspaceId
): string {
  return `${kind}-${workspaceId}`;
}
