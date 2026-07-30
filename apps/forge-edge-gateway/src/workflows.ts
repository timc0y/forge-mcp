import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { WorkspaceId } from '@forge/core';
import {
  workflowRetryPolicy,
  type DestroyWorkspaceParams,
  type ProvisionWorkspaceParams
} from '@forge/workflows-cloudflare';
import type { Env } from './env';
import { workspaceOperations } from './workspace-operations';
import { releaseWorkspaceSlot } from './capacity';

export class ProvisionWorkspaceWorkflow extends WorkflowEntrypoint<
  Env,
  ProvisionWorkspaceParams
> {
  override async run(
    event: Readonly<WorkflowEvent<ProvisionWorkspaceParams>>,
    step: WorkflowStep
  ): Promise<{ workspaceId: WorkspaceId; state: string; revision: number }> {
    try {
      const result = await step.do(
        'provision workspace',
        workflowRetryPolicy,
        async () => {
          const remote = await workspaceOperations(
            this.env,
            event.payload.workspaceId
          ).provisionInitialized({ bootstrap: event.payload.bootstrap });
          if (!remote.ok) {
            const message = `${String(remote.code)}: ${String(remote.message)}`;
            if (!remote.retryable) throw new NonRetryableError(message);
            throw new Error(message);
          }
          return { state: String(remote.state), revision: Number(remote.revision) };
        }
      );
      return {
        workspaceId: event.payload.workspaceId,
        state: result.state,
        revision: result.revision
      };
    } catch (error) {
      await workspaceOperations(this.env, event.payload.workspaceId).provisionExhausted();
      await releaseWorkspaceSlot(this.env.METADATA, event.payload.workspaceId);
      throw error;
    }
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
        const remote = await workspaceOperations(
          this.env,
          event.payload.workspaceId
        ).completeDestroy({ force: event.payload.force });
        return {
          workspaceRevision: Number(remote.workspaceRevision)
        };
      }
    );
    const state = await workspaceOperations(
      this.env,
      event.payload.workspaceId
    ).getState();
    await releaseWorkspaceSlot(this.env.METADATA, event.payload.workspaceId);
    return {
      workspaceId: event.payload.workspaceId,
      state: state.state,
      revision: result.workspaceRevision
    };
  }
}
