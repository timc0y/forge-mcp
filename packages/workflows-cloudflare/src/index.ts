import type { WorkspaceId } from '@forge/core';

export interface ProvisionWorkspaceParams {
  workspaceId: WorkspaceId;
  bootstrap: boolean;
}

export interface DestroyWorkspaceParams {
  workspaceId: WorkspaceId;
  idempotencyKey: string;
  preserveArtifacts: boolean;
  force: boolean;
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
  kind: 'provision' | 'destroy',
  workspaceId: WorkspaceId
): string {
  return `${kind}-${workspaceId}`;
}
