import { ForgeError, type SecretId, type TenantId } from '@forge/core';
import type { ForgeToolHandlers } from '@forge/mcp-core';
import type { Env } from '../env';
import { buildLiveWorkspaceList, buildWorkspaceObserverDetail, observerRepeatDiagnostic } from '../observer-api';
import { completeApproval, requestApproval, requireApproval } from '../github';
import { resolveWorkspaceId } from '../workspace-resolve';
import { hashArgs, priorIdenticalSuccesses, recentToolCalls } from '../tool-call-log';
import { listWorkspaceActivity } from '../workspace-activity';
import { vaultService } from '../vault';
import { DURABILITY_STATES, MUTATION_OUTCOMES } from '../durability';
import { deployCapabilitiesManifest } from '@forge/application';
import { listCloudflareAccounts, resolveCloudflareTokenVar } from '../cloudflare-accounts';

type Identity = { subject: string; tenantId: string; projectId: string };
type SystemTool =
  | 'forge_capabilities'
  | 'forge_observer_workspaces'
  | 'forge_observer_workspace'
  | 'forge_observer_activity'
  | 'forge_secret_list'
  | 'forge_secret_accounts'
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
      deployment: deployCapabilitiesManifest(),
      claims: {
        never_invent_urls: true,
        echo_only_tool_receipts: ['submission_receipt', 'deploy_receipt', 'commit_url']
      },
      observer: { read_only_tools: ['forge_observer_workspaces', 'forge_observer_workspace', 'forge_observer_activity'], live_portal: '/app/live' }
    }),
    forge_observer_workspaces: async (input) => {
      const actor = identity();
      const list = await buildLiveWorkspaceList(env, actor.tenantId);
      const argsHash = await hashArgs(input);
      const prior = await priorIdenticalSuccesses(env, {
        tenantId: actor.tenantId,
        tool: 'forge_observer_workspaces',
        argsHash
      }).catch(() => 0);
      const repeat = observerRepeatDiagnostic('forge_observer_workspaces', prior);
      return asRecord(repeat ? { ...list, ...repeat } : list);
    },
    forge_observer_workspace: async (input) => {
      const actor = identity();
      const workspaceId = await resolveWorkspaceId(env, actor, workspaceAddress(input));
      const detail = await buildWorkspaceObserverDetail(env, actor.tenantId, workspaceId);
      const argsHash = await hashArgs(input);
      const prior = await priorIdenticalSuccesses(env, {
        tenantId: actor.tenantId,
        tool: 'forge_observer_workspace',
        argsHash
      }).catch(() => 0);
      const repeat = observerRepeatDiagnostic('forge_observer_workspace', prior);
      return asRecord(repeat ? { ...detail, ...repeat } : detail);
    },
    forge_observer_activity: async (input) => {
      const actor = identity();
      const workspaceId = hasWorkspaceAddress(input)
        ? await resolveWorkspaceId(env, actor, workspaceAddress(input))
        : undefined;
      const limit = input.limit === undefined ? 40 : Number(input.limit);
      // Complete activity = mcp_tool_calls with payloads. Counters-only was a
      // parallel incomplete view; keep it only via payloads:false.
      if (input.payloads === false && input.errors_only !== true) {
        const activity = await listWorkspaceActivity(env, actor.tenantId, {
          workspaceId,
          limit: Number.isFinite(limit) ? limit : 40,
          since: input.since === undefined ? undefined : text(input.since)
        });
        return { activity, returned: activity.length };
      }
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
    },
    forge_secret_list: async () => {
      const actor = identity();
      const [secrets, attachments] = await Promise.all([
        vaultService(env).list(actor.tenantId as TenantId),
        vaultService(env).attachedSecrets(actor.tenantId as TenantId)
      ]);
      return { secrets, attached: attachments };
    },
    forge_secret_accounts: async (input) => {
      const actor = identity();
      const secretId = text(input.secret_id) as SecretId;
      const secrets = await vaultService(env).list(actor.tenantId as TenantId);
      const secret = secrets.find((candidate) => candidate.id === secretId);
      if (!secret) {
        throw new ForgeError({
          code: 'FORGE_VALIDATION_FAILED',
          message: 'Secret not found. Call forge_secret_list and pass a real secret_id.',
          retryable: false,
          details: { next_step: 'Call forge_secret_list and pass a real secret_id.' }
        });
      }
      const tokenPick = resolveCloudflareTokenVar(
        secret.varNames,
        input.token_var === undefined ? undefined : text(input.token_var)
      );
      if (!tokenPick.ok) {
        throw new ForgeError({
          code: 'FORGE_VALIDATION_FAILED',
          message: `Could not determine which vault env var holds the Cloudflare API token (${secret.varNames.join(', ') || 'none'}). Pass token_var naming the API token key (e.g. CF_KEY), or call forge_secret_list first.`,
          retryable: false,
          details: { var_names: secret.varNames, next_step: tokenPick.next_step }
        });
      }
      const vars = await vaultService(env).decodeVars(actor.tenantId as TenantId, secretId);
      const token = vars[tokenPick.token_var]?.trim();
      if (!token) {
        throw new ForgeError({
          code: 'FORGE_VALIDATION_FAILED',
          message: `Vault var ${tokenPick.token_var} is empty. forge_secret_update the secret with a non-empty API token, then retry forge_secret_accounts.`,
          retryable: false,
          details: {
            next_step: 'forge_secret_update the secret with a non-empty API token, then retry forge_secret_accounts.'
          }
        });
      }
      const listed = await listCloudflareAccounts(token);
      if (!listed.ok) {
        throw new ForgeError({
          code: 'FORGE_VALIDATION_FAILED',
          message: `Could not list Cloudflare accounts: ${listed.message}. Check the API token permissions (Account Settings: Read), then retry forge_secret_accounts.`,
          retryable: listed.status === 429 || listed.status >= 500,
          details: {
            http_status: listed.status || null,
            token_var: tokenPick.token_var,
            next_step:
              'Check the API token permissions (Account Settings: Read is enough to list). Then retry forge_secret_accounts.'
          }
        });
      }
      return {
        secret_id: secretId,
        token_var: tokenPick.token_var,
        accounts: listed.accounts,
        returned: listed.accounts.length,
        next_step:
          listed.accounts.length === 0
            ? 'This token sees no accounts. Use a different token or create an account in Cloudflare, then retry.'
            : listed.accounts.length === 1
              ? `Only one account: ${listed.accounts[0]!.name} (${listed.accounts[0]!.id}). Confirm with the user, then forge_secret_update with env: { CLOUDFLARE_ACCOUNT_ID: "${listed.accounts[0]!.id}" } (merges; token stays), attach, and forge_deploy with map_env if needed.`
              : `Ask the user which Cloudflare account to use, then forge_secret_update with env: { CLOUDFLARE_ACCOUNT_ID: "<chosen id>" } (merges; token stays). Attach to the workspace and call forge_deploy (map_env e.g. { CLOUDFLARE_API_TOKEN: "${tokenPick.token_var}" } if the token is not already named CLOUDFLARE_API_TOKEN).`
      };
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
          ...(input.env === undefined ? {} : { env: input.env as Record<string, string> }),
          ...(input.unset_env === undefined ? {} : { unsetEnv: input.unset_env as string[] })
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
