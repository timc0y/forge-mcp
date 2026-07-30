import { ForgeError, type SecretId, type TenantId } from '@forge/core';
import type { ForgeToolHandlers } from '@forge/mcp-core';
import type { Env } from '../env';
import { buildLiveWorkspaceList, buildWorkspaceObserverDetail } from '../observer-api';
import { completeApproval, requestApproval, requireApproval } from '../github';
import { resolveWorkspaceId } from '../workspace-resolve';
import { recentToolCalls } from '../tool-call-log';
import { listWorkspaceActivity } from '../workspace-activity';
import { vaultService } from '../vault';
import { DURABILITY_STATES, MUTATION_OUTCOMES } from '../durability';

type Identity = { subject: string; tenantId: string; projectId: string };
type SystemTool =
  | 'forge_capabilities'
  | 'forge_observer_workspaces'
  | 'forge_observer_workspace'
  | 'forge_observer_activity'
  | 'forge_secret_list'
  | 'forge_secret_create'
  | 'forge_secret_update'
  | 'forge_secret_delete'
  | 'forge_secret_attach';

const text = (value: unknown): string => String(value);
const workspaceAddress = (input: Record<string, unknown>): { workspace?: unknown } =>
  input.workspace === undefined ? {} : { workspace: input.workspace };
const hasWorkspaceAddress = (input: Record<string, unknown>): boolean =>
  typeof input.workspace === 'string' && input.workspace.length > 0;
const asRecord = (value: object): Record<string, unknown> => value as Record<string, unknown>;

/** System inspection and secret-management workflows behind one handler interface. */
export function systemToolHandlers(
  env: Env,
  identity: () => Identity
): Pick<ForgeToolHandlers, SystemTool> {
  return {
    forge_capabilities: async () => ({
      model: 'remote_first',
      editing: {
        commits_straight_to_github: true,
        push_step: 'none',
        branch: 'cut_by_forge_workspace_create',
        conflict: 're_read_then_edit_again',
        container: 'cache_of_github_resyncs_itself'
      },
      git: {
        mutation_outcomes: MUTATION_OUTCOMES,
        durability_states: DURABILITY_STATES,
        merge: 'forge_merge_opens_pr_for_human_approval',
        pull_requests: 'forge_pr_can_list_status_merge_close',
        branches: 'forge_branches_can_list_and_delete'
      },
      processes: { managed_status: true, persistent_logs: true, preview_requires_exact_process_id: true },
      deployment: {
        cloudflare_wrangler: 'forge_cloudflare_deploy_only',
        ungated_wrangler_shell: 'blocked_requires_approval',
        requires_attached_secret_keys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
        live_claim_requires: 'deploy_receipt.verified_url'
      },
      claims: {
        never_invent_urls: true,
        echo_only_tool_receipts: ['submission_receipt', 'deploy_receipt', 'commit_url']
      },
      observer: { read_only_tools: ['forge_observer_workspaces', 'forge_observer_workspace', 'forge_observer_activity'], live_portal: '/app/live' }
    }),
    forge_observer_workspaces: async () => {
      const actor = identity();
      return asRecord(await buildLiveWorkspaceList(env, actor.tenantId));
    },
    forge_observer_workspace: async (input) => {
      const actor = identity();
      const workspaceId = await resolveWorkspaceId(env, actor, workspaceAddress(input));
      return asRecord(await buildWorkspaceObserverDetail(env, actor.tenantId, workspaceId));
    },
    forge_observer_activity: async (input) => {
      const actor = identity();
      const workspaceId = hasWorkspaceAddress(input)
        ? await resolveWorkspaceId(env, actor, workspaceAddress(input))
        : undefined;
      const limit = input.limit === undefined ? 40 : Number(input.limit);
      const since = input.since === undefined ? undefined : text(input.since);
      if (input.payloads === true || input.errors_only === true) {
        const calls = await recentToolCalls(env, {
          tenantId: actor.tenantId,
          workspaceId,
          onlyErrors: input.errors_only === true,
          limit: Number.isFinite(limit) ? limit : 40
        });
        return {
          calls,
          returned: calls.length,
          note: 'Secret-shaped keys are redacted and long values previewed; request_bytes/response_bytes are the true sizes.'
        };
      }
      const activity = await listWorkspaceActivity(env, actor.tenantId, {
        workspaceId,
        limit: Number.isFinite(limit) ? limit : 40,
        since
      });
      return { activity, returned: activity.length };
    },
    forge_secret_list: async () => {
      const actor = identity();
      const [secrets, attachments] = await Promise.all([
        vaultService(env).list(actor.tenantId as TenantId),
        vaultService(env).attachedSecrets(actor.tenantId as TenantId)
      ]);
      return { secrets, attached: attachments };
    },
    forge_secret_create: async (input) => {
      const actor = identity();
      const secret = await vaultService(env).create(
        actor.tenantId as TenantId,
        text(input.label), input.provider as 'cloudflare' | 'shopify' | 'generic',
        input.env as Record<string, string>
      );
      return { secret };
    },
    forge_secret_update: async (input) => {
      const actor = identity();
      const secret = await vaultService(env).update(
        actor.tenantId as TenantId, text(input.secret_id) as SecretId,
        {
          ...(input.label === undefined ? {} : { label: text(input.label) }),
          ...(input.provider === undefined ? {} : { provider: input.provider as 'cloudflare' | 'shopify' | 'generic' }),
          ...(input.env === undefined ? {} : { env: input.env as Record<string, string> })
        }
      );
      return { secret };
    },
    forge_secret_delete: async (input) => {
      const actor = identity();
      await vaultService(env).delete(actor.tenantId as TenantId, text(input.secret_id) as SecretId);
      return { deleted_secret_id: text(input.secret_id) };
    },
    forge_secret_attach: async (input) => {
      const actor = identity();
      const secretId = text(input.secret_id) as SecretId;
      const workspaceId = await resolveWorkspaceId(env, actor, workspaceAddress(input));
      if (input.attached === false) {
        await vaultService(env).detach(actor.tenantId as TenantId, secretId, workspaceId);
        return { attached: false, secret_id: secretId, workspace_id: workspaceId };
      }
      const approvalId = input.approval_id ? text(input.approval_id) : undefined;
      if (!approvalId) {
        const secret = (await vaultService(env).list(actor.tenantId as TenantId)).find(
          (candidate) => candidate.id === secretId
        );
        const varNames = secret?.varNames.join(', ') ?? 'unknown';
        const approval = await requestApproval(env, actor, workspaceId, 'secret.attach',
          `Attach secret "${secret?.label ?? secretId}" to workspace ${workspaceId}`,
          { secret_id: secretId, workspace_id: workspaceId, var_names: varNames }
        );
        if (approval.already_approved) {
          await vaultService(env).attach(actor.tenantId as TenantId, secretId, workspaceId);
          return { attached: true, secret_id: secretId, workspace_id: workspaceId };
        }
        throw new ForgeError({
          code: 'FORGE_APPROVAL_REQUIRED', message: 'This attach needs human approval. Open the approval URL, approve it, then retry with approval_id.',
          retryable: false, details: { kind: 'approval', action: 'secret.attach', ...approval }
        });
      }
      await requireApproval(env, actor, approvalId, workspaceId, 'secret.attach',
        { secret_id: secretId, workspace_id: workspaceId }
      );
      await vaultService(env).attach(actor.tenantId as TenantId, secretId, workspaceId);
      await completeApproval(env, approvalId, true);
      return { attached: true, secret_id: secretId, workspace_id: workspaceId };
    }
  };
}
