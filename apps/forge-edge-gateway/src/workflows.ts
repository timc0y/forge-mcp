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
import type { WorkspaceCoordinator } from './workspace-coordinator';
import { releaseWorkspaceSlot } from './capacity';

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
    try {
      const result = await step.do(
        'provision workspace',
        workflowRetryPolicy,
        async () => {
          const remote = await coordinator(
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
      // Restore a prior snapshot over the freshly provisioned workspace so a
      // reaped harness comes back with its deps/build/uncommitted work intact.
      // Best-effort and gated — a no-op when snapshots are disabled or absent.
      await step.do('restore snapshot', workflowRetryPolicy, async () => {
        await coordinator(this.env, event.payload.workspaceId).restoreFromR2();
        return true;
      }).catch(() => undefined);
      return {
        workspaceId: event.payload.workspaceId,
        state: result.state,
        revision: result.revision
      };
    } catch (error) {
      await coordinator(this.env, event.payload.workspaceId).provisionExhausted();
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
    await releaseWorkspaceSlot(this.env.METADATA, event.payload.workspaceId);
    return {
      workspaceId: event.payload.workspaceId,
      state: state.state,
      revision: result.workspaceRevision
    };
  }
}
