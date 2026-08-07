import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './env';
import { ChatOperationStore, reconcileChatOperation } from './chat-operations';

interface ChatOperationWorkflowParams {
  tenantId: string;
  operationId: string;
}

/** Completes and cleans up long Chat work even when the conversation stops. */
export class ChatOperationWorkflow extends WorkflowEntrypoint<Env, ChatOperationWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<ChatOperationWorkflowParams>>,
    step: WorkflowStep
  ): Promise<{ operationId: string; state: string }> {
    const { tenantId, operationId } = event.payload;
    for (let attempt = 0; attempt < 180; attempt++) {
      if (attempt > 0) await step.sleep(`wait for operation ${attempt}`, '10 seconds');
      const state = await step.do(`reconcile operation ${attempt}`, async () => {
        const store = new ChatOperationStore(this.env.METADATA);
        const operation = await store.get(tenantId, operationId);
        if (!operation) return 'expired';
        return (await reconcileChatOperation(this.env, tenantId, operation)).state;
      });
      if (state !== 'running') return { operationId, state };
    }
    return { operationId, state: 'running' };
  }
}
