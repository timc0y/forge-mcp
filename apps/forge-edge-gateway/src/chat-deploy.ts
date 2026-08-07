import { resolveDeployWorkflow, type DeployWorkflowId } from '@forge/application';
import { ForgeError, type ProcessId, type TenantId } from '@forge/core';
import type { Env } from './env';
import { ChatOperationStore, discardChatExecutor } from './chat-operations';
import { vaultService } from './vault';
import { executorCoordinator } from './handlers/helpers';

interface ApprovedChatDeployPayload {
  chat_operation_id?: unknown;
  project_id?: unknown;
  repository?: unknown;
  repository_ref?: unknown;
  profileId?: unknown;
  workflow?: unknown;
  command?: unknown;
  cwd?: unknown;
  accountId?: unknown;
  mapEnv?: unknown;
  expectedUrl?: unknown;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `Approved deployment is missing ${name}; use forge_deploy to create a fresh approval receipt.`,
      retryable: false
    });
  }
  return value;
}

/**
 * Redeem a hosted deploy approval without an MCP caller waiting to retry.
 * The approval row already binds this exact payload to the tenant and reviewer.
 */
export async function startApprovedChatDeploy(env: Env, input: {
  tenantId: string;
  workspaceId: string;
  approvalId: string;
  payload: ApprovedChatDeployPayload;
}): Promise<void> {
  const operationId = requiredString(input.payload.chat_operation_id, 'the operation receipt');
  const projectId = requiredString(input.payload.project_id, 'the project binding');
  const command = requiredString(input.payload.command, 'the approved command');
  const cwd = requiredString(input.payload.cwd, 'the approved working directory');
  const workflow = requiredString(input.payload.workflow, 'the approved workflow') as DeployWorkflowId;
  const store = new ChatOperationStore(env.METADATA);
  try {
    const attached = await vaultService(env).attachedEnv(input.tenantId as TenantId, input.workspaceId);
    if (typeof input.payload.accountId === 'string' && input.payload.accountId) {
      attached.vars.CLOUDFLARE_ACCOUNT_ID = input.payload.accountId;
    }
    const mapEnv = input.payload.mapEnv && typeof input.payload.mapEnv === 'object'
      ? input.payload.mapEnv as Record<string, string>
      : undefined;
    const resolved = resolveDeployWorkflow({
      attachedVars: attached.vars,
      mapEnv,
      command,
      prefer: workflow
    });
    if (!resolved.ok) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: `The approved environment is no longer ready: ${resolved.reason}. Use forge_environments before retrying forge_deploy.`,
        retryable: false
      });
    }
    const workspace = await executorCoordinator(env, {
      subject: 'approval-page', tenantId: input.tenantId, projectId, clientId: 'forge-web'
    }, input.workspaceId);
    const started = await workspace.processStart({
      command,
      cwd,
      environment: resolved.resolution.processEnv,
      networkPolicy: 'development',
      expectedRevision: undefined,
      idempotencyKey: `approved-deploy-${input.approvalId}`,
      approved: true
    }) as unknown as Record<string, unknown>;
    const value = started.value && typeof started.value === 'object'
      ? started.value as Record<string, unknown>
      : started;
    const processId = value.id ?? started.processId ?? started.id;
    if (typeof processId !== 'string' || !processId.startsWith('proc_')) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_CONFLICT',
        message: 'The approved deployment did not start correctly; retry forge_deploy with a fresh approval receipt.',
        retryable: false
      });
    }
    await store.update(input.tenantId, operationId, {
      state: 'running',
      summary: 'Deployment approved and running.',
      result: {
        workspace_id: input.workspaceId,
        process_id: processId as ProcessId,
        expected_url: typeof input.payload.expectedUrl === 'string' ? input.payload.expectedUrl : null,
        workflow,
        approval_id: input.approvalId
      }
    });
    await env.CHAT_OPERATION_WORKFLOW.create({
      id: `chat-operation-${operationId}`,
      params: { tenantId: input.tenantId, operationId }
    });
  } catch (error) {
    await store.complete(input.tenantId, operationId, {
      state: 'failed',
      summary: 'The approved deployment could not start.',
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Unknown deployment error.'
    }).catch(() => undefined);
    throw error;
  }
}

export async function denyApprovedChatDeploy(env: Env, tenantId: string, workspaceId: string, payload: ApprovedChatDeployPayload): Promise<void> {
  if (typeof payload.chat_operation_id !== 'string') return;
  await new ChatOperationStore(env.METADATA).complete(tenantId, payload.chat_operation_id, {
    state: 'failed', summary: 'Deployment was declined by the reviewer.'
  });
  await discardChatExecutor(env, workspaceId, payload.chat_operation_id);
}
