/**
 * Agent-driven deploy env resolution.
 *
 * Vault secrets stay generic (arbitrary KEY=value). Forge does not guess
 * Cloudflare/provider aliases. The agent lists attached names via
 * forge_secret_list, then passes map_env to rename them into whatever the
 * deploy CLI expects (e.g. CF_KEY → CLOUDFLARE_API_TOKEN).
 */

export type DeployWorkflowId = 'cloudflare_wrangler';

export interface DeployWorkflowHint {
  id: DeployWorkflowId;
  label: string;
  /** Process env names required after map_env (not vault aliases). */
  requires_process_env: readonly string[];
  /** Useful when present (e.g. account pinning) but not required to start. */
  optional_process_env?: readonly string[];
  defaultCommand: string;
}

export const DEPLOY_WORKFLOWS: readonly DeployWorkflowHint[] = [
  {
    id: 'cloudflare_wrangler',
    label: 'Cloudflare Wrangler',
    // Token is required. Account id is optional: when present Forge pins the
    // deploy in approval/receipt; when absent Wrangler uses account from
    // wrangler config / the token's default account.
    requires_process_env: ['CLOUDFLARE_API_TOKEN'],
    optional_process_env: ['CLOUDFLARE_ACCOUNT_ID'],
    defaultCommand: 'npx wrangler deploy'
  }
] as const;

export interface ResolvedDeploy {
  workflow: DeployWorkflowId;
  accountId: string | null;
  /** Process env for the managed command (attached vars + agent map_env). */
  processEnv: Record<string, string>;
  /** Agent-supplied processKey → attachedKey mapping that was applied. */
  mapEnv: Record<string, string>;
}

export type DeployResolveResult =
  | { ok: true; resolution: ResolvedDeploy }
  | {
      ok: false;
      reason:
        | 'no_attached_vars'
        | 'unknown_map_source'
        | 'incomplete_credentials'
        | 'no_matching_workflow';
      attached_var_names: string[];
      workflows: DeployWorkflowHint[];
      missing_process_env?: string[];
      unknown_sources?: string[];
      next_step: string;
    };

/** map_env: process env name → attached vault var name. */
export function applyDeployEnvMap(
  attachedVars: Record<string, string>,
  mapEnv: Record<string, string> | undefined
): { ok: true; processEnv: Record<string, string>; mapEnv: Record<string, string> } | {
  ok: false;
  unknown_sources: string[];
} {
  const processEnv: Record<string, string> = { ...attachedVars };
  const applied: Record<string, string> = {};
  if (!mapEnv || Object.keys(mapEnv).length === 0) {
    return { ok: true, processEnv, mapEnv: applied };
  }
  const unknown: string[] = [];
  for (const [processKey, attachedKey] of Object.entries(mapEnv)) {
    const source = attachedKey.trim();
    const dest = processKey.trim();
    if (!dest || !source) continue;
    const value = attachedVars[source];
    if (value === undefined) {
      unknown.push(source);
      continue;
    }
    processEnv[dest] = value;
    applied[dest] = source;
  }
  if (unknown.length > 0) return { ok: false, unknown_sources: unknown.sort() };
  return { ok: true, processEnv, mapEnv: applied };
}

export function detectDeployWorkflow(
  command: string,
  processEnv: Record<string, string>,
  prefer?: DeployWorkflowId | 'auto'
): DeployWorkflowId | null {
  if (prefer && prefer !== 'auto') return prefer;
  if (/\bwrangler\b/i.test(command)) return 'cloudflare_wrangler';
  const cf = DEPLOY_WORKFLOWS.find((w) => w.id === 'cloudflare_wrangler');
  if (cf && cf.requires_process_env.every((name) => Boolean(processEnv[name]?.trim()))) {
    return 'cloudflare_wrangler';
  }
  return null;
}

/**
 * Resolve deploy process env from attached vault vars + optional agent map_env.
 * Forge never invents Cloudflare alias names; the agent chooses the mapping.
 */
export function resolveDeployWorkflow(input: {
  attachedVars: Record<string, string>;
  mapEnv?: Record<string, string>;
  command: string;
  prefer?: DeployWorkflowId | 'auto';
}): DeployResolveResult {
  const names = Object.keys(input.attachedVars).sort();
  const workflows = [...DEPLOY_WORKFLOWS];

  if (names.length === 0) {
    return {
      ok: false,
      reason: 'no_attached_vars',
      attached_var_names: names,
      workflows,
      next_step:
        'Create a vault secret with your deploy credentials (any env names), attach it with forge_secret_attach, then call forge_deploy. If the CLI needs different names than your vault keys, pass map_env (e.g. { "CLOUDFLARE_API_TOKEN": "CF_KEY" }). CLOUDFLARE_ACCOUNT_ID is optional — when set it pins the account in approval.'
    };
  }

  const mapped = applyDeployEnvMap(input.attachedVars, input.mapEnv);
  if (!mapped.ok) {
    return {
      ok: false,
      reason: 'unknown_map_source',
      attached_var_names: names,
      workflows,
      unknown_sources: mapped.unknown_sources,
      next_step: `map_env references vault vars that are not attached: ${mapped.unknown_sources.join(', ')}. Call forge_secret_list, fix the source names, then retry.`
    };
  }

  const workflow = detectDeployWorkflow(input.command, mapped.processEnv, input.prefer);
  if (!workflow) {
    return {
      ok: false,
      reason: 'no_matching_workflow',
      attached_var_names: names,
      workflows,
      next_step:
        `Could not select a deploy workflow from command "${input.command}" and attached vars (${names.join(', ')}). Pass workflow explicitly, use a wrangler deploy command, or map_env so the process env includes the CLI's required names.`
    };
  }

  const hint = workflows.find((w) => w.id === workflow)!;
  const missing = hint.requires_process_env.filter((name) => !mapped.processEnv[name]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'incomplete_credentials',
      attached_var_names: names,
      workflows,
      missing_process_env: missing,
      next_step:
        `Workflow ${workflow} needs process env ${missing.join(' + ')}. Attached vault names: ${names.join(', ') || 'none'}. Pass map_env to rename them (example: { "${missing[0]}": "CF_KEY" }), or store the secret under the CLI names directly.`
    };
  }

  return {
    ok: true,
    resolution: {
      workflow,
      accountId: mapped.processEnv.CLOUDFLARE_ACCOUNT_ID?.trim() || null,
      processEnv: mapped.processEnv,
      mapEnv: mapped.mapEnv
    }
  };
}

/** Capabilities / guidance payload — agent chooses env names via map_env. */
export function deployCapabilitiesManifest(): {
  tool: 'forge_deploy';
  selection: 'agent_map_env_from_attached_secret_names';
  map_env: 'process_env_name_to_attached_vault_var_name';
  workflows: Array<{
    id: DeployWorkflowId;
    label: string;
    requires_process_env: readonly string[];
    optional_process_env?: readonly string[];
    default_command: string;
  }>;
  live_claim_requires: 'deploy_receipt.verified_url';
  ungated_provider_cli_via_shell: 'blocked_requires_approval';
} {
  return {
    tool: 'forge_deploy',
    selection: 'agent_map_env_from_attached_secret_names',
    map_env: 'process_env_name_to_attached_vault_var_name',
    workflows: DEPLOY_WORKFLOWS.map((w) => ({
      id: w.id,
      label: w.label,
      requires_process_env: w.requires_process_env,
      ...(w.optional_process_env ? { optional_process_env: w.optional_process_env } : {}),
      default_command: w.defaultCommand
    })),
    live_claim_requires: 'deploy_receipt.verified_url',
    ungated_provider_cli_via_shell: 'blocked_requires_approval'
  };
}
