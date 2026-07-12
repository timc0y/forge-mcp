import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from 'cloudflare:workers';
import type { WorkspaceId } from '@forge/core';
import {
  workflowRetryPolicy,
  type DestroyWorkspaceParams,
  type ProvisionWorkspaceParams
} from '@forge/workflows-cloudflare';
import type { Env } from './env';
import type { WorkspaceCoordinator } from './workspace-coordinator';

function coordinator(
  env: Env,
  workspaceId: WorkspaceId
): DurableObjectStub<WorkspaceCoordinator> {
  return env.WORKSPACE_COORDINATORS.get(
    env.WORKSPACE_COORDINATORS.idFromName(workspaceId)
  );
}

export class ProvisionWorkspaceWorkflow extends WorkflowEntrypoint<
  Env,
  ProvisionWorkspaceParams
> {
  override async run(
    event: Readonly<WorkflowEvent<ProvisionWorkspaceParams>>,
    step: WorkflowStep
  ): Promise<{ workspaceId: WorkspaceId; state: string; revision: number }> {
    const result = await step.do(
      'provision workspace',
      workflowRetryPolicy,
      async () => {
        const remote = await coordinator(
          this.env,
          event.payload.workspaceId
        ).provisionInitialized({ bootstrap: event.payload.bootstrap });
        return { state: String(remote.state), revision: Number(remote.revision) };
      }
    );
    return {
      workspaceId: event.payload.workspaceId,
      state: result.state,
      revision: result.revision
    };
  }
}

export class DestroyWorkspaceWorkflow extends WorkflowEntrypoint<
  Env,
  DestroyWorkspaceParams
> {
  override async run(
    event: Readonly<WorkflowEvent<DestroyWorkspaceParams>>,
    step: WorkflowStep
  ): Promise<{ workspaceId: WorkspaceId; state: string; revision: number }> {
    const result = await step.do(
      'destroy workspace',
      workflowRetryPolicy,
      async () => {
        const remote = await coordinator(
          this.env,
          event.payload.workspaceId
        ).completeDestroy();
        return {
          workspaceRevision: Number(remote.workspaceRevision)
        };
      }
    );
    const state = await coordinator(
      this.env,
      event.payload.workspaceId
    ).getState();
    return {
      workspaceId: event.payload.workspaceId,
      state: state.state,
      revision: result.workspaceRevision
    };
  }
}
