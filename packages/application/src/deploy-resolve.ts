/**
 * Env-driven deploy workflow selection.
 *
 * Vault secrets stay generic (arbitrary KEY=value). Deploy tools inspect the
 * attached env names and pick a known workflow — they do not require one
 * provider-specific secret shape. Values are normalized to the names the
 * underlying CLI expects (e.g. Wrangler wants CLOUDFLARE_API_TOKEN).
 */

export type DeployWorkflowId = 'cloudflare_wrangler';

export interface DeployWorkflowHint {
  id: DeployWorkflowId;
  /** Human label for capabilities / errors. */
  label: string;
  /** Env names accepted for each required credential (first match wins). */
  accepts: Record<string, readonly string[]>;
  defaultCommand: string;
}

export const DEPLOY_WORKFLOWS: readonly DeployWorkflowHint[] = [
  {
    id: 'cloudflare_wrangler',
    label: 'Cloudflare Wrangler',
    accepts: {
      api_token: ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_TOKEN', 'CF_TOKEN'],
      account_id: ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT']
    },
    defaultCommand: 'npx wrangler deploy'
  }
] as const;

export interface ResolvedCloudflareDeploy {
  workflow: 'cloudflare_wrangler';
  apiToken: string;
  accountId: string;
  /** Source env names that supplied the credentials (for audit / next_step). */
  matched: { api_token: string; account_id: string };
  /**
   * Env to inject into the managed process: original attached vars plus
   * canonical Wrangler names so the CLI always sees what it expects.
   */
  processEnv: Record<string, string>;
}

export type DeployResolveResult =
  | { ok: true; resolution: ResolvedCloudflareDeploy }
  | {
      ok: false;
      reason: 'no_attached_vars' | 'no_matching_workflow' | 'incomplete_credentials';
      attached_var_names: string[];
      workflows: DeployWorkflowHint[];
      partial?: { workflow: DeployWorkflowId; missing: string[]; found: string[] };
      next_step: string;
    };

function firstPresent(
  vars: Record<string, string>,
  aliases: readonly string[]
): { name: string; value: string } | null {
  for (const name of aliases) {
    const value = vars[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

/** Resolve a Cloudflare Wrangler deploy from attached env (aliases allowed). */
export function resolveCloudflareDeploy(
  attachedVars: Record<string, string>
): ResolvedCloudflareDeploy | null {
  const hint = DEPLOY_WORKFLOWS.find((w) => w.id === 'cloudflare_wrangler');
  if (!hint) return null;
  const token = firstPresent(attachedVars, hint.accepts.api_token!);
  const account = firstPresent(attachedVars, hint.accepts.account_id!);
  if (!token || !account) return null;
  return {
    workflow: 'cloudflare_wrangler',
    apiToken: token.value,
    accountId: account.value,
    matched: { api_token: token.name, account_id: account.name },
    processEnv: {
      ...attachedVars,
      CLOUDFLARE_API_TOKEN: token.value,
      CLOUDFLARE_ACCOUNT_ID: account.value
    }
  };
}

/**
 * Pick a deploy workflow from attached env vars.
 * `prefer` forces one workflow (used by forge_cloudflare_deploy); otherwise
 * the first complete match wins.
 */
export function resolveDeployWorkflow(
  attachedVars: Record<string, string>,
  prefer?: DeployWorkflowId
): DeployResolveResult {
  const names = Object.keys(attachedVars).sort();
  const workflows = [...DEPLOY_WORKFLOWS];

  if (names.length === 0) {
    return {
      ok: false,
      reason: 'no_attached_vars',
      attached_var_names: names,
      workflows,
      next_step:
        'Create a vault secret with the deploy credentials (forge_secret_create or /app/secrets), attach it with forge_secret_attach, then retry forge_deploy. Cloudflare accepts CLOUDFLARE_API_TOKEN+CLOUDFLARE_ACCOUNT_ID or aliases CF_API_TOKEN/CF_ACCOUNT_ID.'
    };
  }

  if (prefer === 'cloudflare_wrangler' || prefer === undefined) {
    const cloudflare = resolveCloudflareDeploy(attachedVars);
    if (cloudflare) return { ok: true, resolution: cloudflare };

    const hint = DEPLOY_WORKFLOWS.find((w) => w.id === 'cloudflare_wrangler')!;
    const token = firstPresent(attachedVars, hint.accepts.api_token!);
    const account = firstPresent(attachedVars, hint.accepts.account_id!);
    if (prefer === 'cloudflare_wrangler' || token || account) {
      const missing: string[] = [];
      const found: string[] = [];
      if (token) found.push(token.name);
      else missing.push('api_token (CLOUDFLARE_API_TOKEN | CF_API_TOKEN | CLOUDFLARE_TOKEN | CF_TOKEN)');
      if (account) found.push(account.name);
      else missing.push('account_id (CLOUDFLARE_ACCOUNT_ID | CF_ACCOUNT_ID | CLOUDFLARE_ACCOUNT)');
      return {
        ok: false,
        reason: 'incomplete_credentials',
        attached_var_names: names,
        workflows,
        partial: { workflow: 'cloudflare_wrangler', missing, found },
        next_step:
          'Attached secrets are missing a complete Cloudflare credential pair. Update the secret so both an API token and account id are present (canonical or alias names), re-attach if needed, then retry forge_deploy.'
      };
    }
  }

  return {
    ok: false,
    reason: 'no_matching_workflow',
    attached_var_names: names,
    workflows,
    next_step:
      `No known deploy workflow matches the attached env names (${names.join(', ') || 'none'}). Today forge_deploy supports Cloudflare Wrangler when a token+account pair is present. Add those vars or use forge_shell for a different provider after approval.`
  };
}

/** Capabilities / guidance payload describing env-driven deploy selection. */
export function deployCapabilitiesManifest(): {
  tool: 'forge_deploy';
  selection: 'from_attached_secret_env_names';
  alias_tools: { cloudflare_wrangler: 'forge_cloudflare_deploy' };
  workflows: Array<{
    id: DeployWorkflowId;
    label: string;
    accepts_env: Record<string, readonly string[]>;
    default_command: string;
  }>;
  live_claim_requires: 'deploy_receipt.verified_url';
  ungated_provider_cli_via_shell: 'blocked_requires_approval';
} {
  return {
    tool: 'forge_deploy',
    selection: 'from_attached_secret_env_names',
    alias_tools: { cloudflare_wrangler: 'forge_cloudflare_deploy' },
    workflows: DEPLOY_WORKFLOWS.map((w) => ({
      id: w.id,
      label: w.label,
      accepts_env: w.accepts,
      default_command: w.defaultCommand
    })),
    live_claim_requires: 'deploy_receipt.verified_url',
    ungated_provider_cli_via_shell: 'blocked_requires_approval'
  };
}
