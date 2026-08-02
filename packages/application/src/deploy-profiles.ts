import type { DeployWorkflowId } from './deploy-resolve.js';

export type DeployEnvironment = 'preview' | 'staging' | 'production';

export interface DeployProfile {
  profile_id: string;
  label: string;
  repository: { provider: 'github'; owner: string; name: string };
  workflow: DeployWorkflowId;
  environment: DeployEnvironment;
  cwd: string;
  command: string;
  expected_url?: string;
  expected_worker_name?: string;
  account_id?: string;
  map_env: Record<string, string>;
  approved_by: string;
  approved_at: string;
  source_hint: string;
  profile_hash: string;
  state: 'approved' | 'stale' | 'disabled';
}

export interface DeployProfileDraft {
  label: string;
  repository: { provider: 'github'; owner: string; name: string };
  workflow: DeployWorkflowId;
  environment: DeployEnvironment;
  cwd: string;
  command: string;
  expected_url?: string;
  expected_worker_name?: string;
  account_id?: string;
  map_env: Record<string, string>;
  source_hint: string;
}

export interface DeployProfileFile {
  path: string;
  content: string;
}

export type DeployProfilePlanResult =
  | {
      state: 'ready_to_approve';
      draft: DeployProfileDraft;
      detected: Record<string, unknown>;
      profile_hash: string;
      next_step: string;
      allowedNextActions: string[];
    }
  | {
      state: 'needs_user_choice' | 'blocked';
      candidates?: DeployProfileDraft[];
      detected: Record<string, unknown>;
      next_step: string;
      allowedNextActions: string[];
    };

const DEFAULT_MAP_ENV = {
  CLOUDFLARE_API_TOKEN: 'CLOUDFLARE_API_TOKEN'
} as const;

function repoLabel(repository: DeployProfileDraft['repository']): string {
  return `${repository.owner}/${repository.name}`;
}

function normalizeCwd(path: string): string {
  const clean = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (!clean || clean === '.') return '/workspace/repo';
  return `/workspace/repo/${clean.replace(/^\/+/u, '')}`;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

function parseTomlString(content: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'mu');
  return content.match(pattern)?.[1]?.trim();
}

function inferEnvironment(command: string, label: string): DeployEnvironment {
  const lower = `${command} ${label}`.toLowerCase();
  if (/\bprod(uction)?\b/u.test(lower)) return 'production';
  if (/\bstag(e|ing)?\b/u.test(lower)) return 'staging';
  return 'preview';
}

function commandForWranglerConfig(_path: string): string {
  return 'npx wrangler deploy';
}

function packageManagerCommand(packagePath: string, scriptName: string): string {
  if (packagePath === 'package.json') return `npm run ${scriptName}`;
  return `pnpm --filter ${dirname(packagePath).split('/').pop() ?? '.'} ${scriptName}`;
}

function deployScriptNames(pkg: Record<string, unknown>): string[] {
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts as Record<string, unknown> : {};
  return Object.entries(scripts)
    .filter(([name, value]) => /deploy/u.test(name) && typeof value === 'string' && /\bwrangler\b/u.test(value))
    .map(([name]) => name)
    .sort();
}

function deployJsonCandidates(
  file: DeployProfileFile,
  repository: DeployProfileDraft['repository'],
  fallbackEnvironment?: DeployEnvironment
): DeployProfileDraft[] {
  try {
    const parsed = JSON.parse(file.content) as unknown;
    const rawProfiles = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { profiles?: unknown }).profiles)
        ? (parsed as { profiles: unknown[] }).profiles
        : parsed && typeof parsed === 'object'
          ? [parsed]
          : [];
    return rawProfiles.flatMap((raw, index) => {
      if (!raw || typeof raw !== 'object') return [];
      const profile = raw as Record<string, unknown>;
      if (typeof profile.command !== 'string' || !/\bwrangler\b/u.test(profile.command)) return [];
      const label = typeof profile.label === 'string' && profile.label.trim()
        ? profile.label.trim()
        : `${repoLabel(repository)} deploy`;
      const cwd = typeof profile.cwd === 'string' && profile.cwd.trim()
        ? profile.cwd.trim()
        : '/workspace/repo';
      const mapEnv = profile.map_env && typeof profile.map_env === 'object'
        ? Object.fromEntries(
            Object.entries(profile.map_env as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          )
        : { ...DEFAULT_MAP_ENV };
      return [{
        label,
        repository,
        workflow: 'cloudflare_wrangler' as const,
        environment: fallbackEnvironment ?? (typeof profile.environment === 'string'
          && ['preview', 'staging', 'production'].includes(profile.environment)
          ? profile.environment as DeployEnvironment
          : inferEnvironment(profile.command, label)),
        cwd: cwd.startsWith('/workspace') ? cwd : normalizeCwd(cwd),
        command: profile.command.trim(),
        ...(typeof profile.expected_url === 'string' ? { expected_url: profile.expected_url } : {}),
        ...(typeof profile.expected_worker_name === 'string' ? { expected_worker_name: profile.expected_worker_name } : {}),
        ...(typeof profile.account_id === 'string' ? { account_id: profile.account_id } : {}),
        map_env: mapEnv,
        source_hint: `${file.path}${rawProfiles.length > 1 ? `#${index}` : ''}`
      }];
    });
  } catch {
    return [];
  }
}

export function deployProfileFingerprint(draft: Omit<DeployProfileDraft, 'source_hint'> & { source_hint?: string }): string {
  const stable = {
    repository: draft.repository,
    workflow: draft.workflow,
    environment: draft.environment,
    cwd: draft.cwd,
    command: draft.command,
    expected_url: draft.expected_url ?? null,
    expected_worker_name: draft.expected_worker_name ?? null,
    account_id: draft.account_id ?? null,
    map_env: Object.fromEntries(Object.entries(draft.map_env).sort(([a], [b]) => a.localeCompare(b)))
  };
  return JSON.stringify(stable);
}

export async function hashDeployProfile(draft: Omit<DeployProfileDraft, 'source_hint'> & { source_hint?: string }): Promise<string> {
  const bytes = new TextEncoder().encode(deployProfileFingerprint(draft));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function deployProfileCandidates(input: {
  repository: DeployProfileDraft['repository'];
  files: DeployProfileFile[];
  environment?: DeployEnvironment;
}): { candidates: DeployProfileDraft[]; detected: Record<string, unknown> } {
  const wranglerFiles = input.files
    .filter((file) => /(^|\/)wrangler\.(toml|jsonc?)$/u.test(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const packageFiles = input.files
    .filter((file) => /(^|\/)package\.json$/u.test(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const deployJsonFiles = input.files
    .filter((file) => file.path === '.forge/deploy.json')
    .sort((a, b) => a.path.localeCompare(b.path));

  const deployJsonHints = deployJsonFiles.flatMap((file) =>
    deployJsonCandidates(file, input.repository, input.environment)
  );
  const scriptCandidates: DeployProfileDraft[] = [];
  for (const file of packageFiles) {
    try {
      const pkg = JSON.parse(file.content) as Record<string, unknown>;
      for (const scriptName of deployScriptNames(pkg)) {
        const command = packageManagerCommand(file.path, scriptName);
        scriptCandidates.push({
          label: `${repoLabel(input.repository)} ${scriptName}`,
          repository: input.repository,
          workflow: 'cloudflare_wrangler',
          environment: input.environment ?? inferEnvironment(command, scriptName),
          cwd: normalizeCwd(dirname(file.path)),
          command,
          map_env: { ...DEFAULT_MAP_ENV },
          source_hint: `${file.path} scripts.${scriptName}`
        });
      }
    } catch {
      // Ignore invalid package hints; repo config is only advisory.
    }
  }

  const configCandidates: DeployProfileDraft[] = wranglerFiles.map((file) => {
    const workerName = parseTomlString(file.content, 'name');
    const command = commandForWranglerConfig(file.path);
    return {
      label: workerName ? `${workerName} deploy` : `${repoLabel(input.repository)} deploy`,
      repository: input.repository,
      workflow: 'cloudflare_wrangler',
      environment: input.environment ?? inferEnvironment(command, workerName ?? file.path),
      cwd: normalizeCwd(dirname(file.path)),
      command,
      ...(workerName ? { expected_worker_name: workerName } : {}),
      map_env: { ...DEFAULT_MAP_ENV },
      source_hint: file.path
    };
  });
  return {
    candidates: [...deployJsonHints, ...scriptCandidates, ...configCandidates],
    detected: {
      forge_deploy_json_paths: deployJsonFiles.map((file) => file.path),
      wrangler_config_paths: wranglerFiles.map((file) => file.path),
      package_script_hints: scriptCandidates.map((candidate) => candidate.source_hint)
    }
  };
}

export async function planCloudflareDeployProfile(input: {
  repository: DeployProfileDraft['repository'];
  files: DeployProfileFile[];
  environment?: DeployEnvironment;
}): Promise<DeployProfilePlanResult> {
  const { candidates: allCandidates, detected } = deployProfileCandidates(input);
  const deployJsonCandidates = allCandidates.filter((candidate) => candidate.source_hint.startsWith('.forge/deploy.json'));
  const scriptCandidates = allCandidates.filter((candidate) => candidate.source_hint.includes(' scripts.'));
  const configCandidates = allCandidates.filter((candidate) => /(^|\/)wrangler\.(toml|jsonc?)$/u.test(candidate.source_hint));
  const candidates = deployJsonCandidates.length > 0
    ? deployJsonCandidates
    : scriptCandidates.length > 0
      ? scriptCandidates
      : configCandidates;
  if (candidates.length === 0) {
    return {
      state: 'blocked',
      detected,
      next_step: 'No Cloudflare Wrangler deploy profile was detected. Pass command and cwd to forge_deploy directly, or add a deploy script/wrangler.toml and retry forge_deploy_profile_plan.',
      allowedNextActions: ['forge_deploy', 'forge_files_read']
    };
  }
  if (candidates.length > 1) {
    return {
      state: 'needs_user_choice',
      candidates,
      detected,
      next_step: 'Multiple Cloudflare deploy candidates were found. Ask the user which command/cwd should become the approved deploy profile, then call forge_deploy_profile_approve with those fields.',
      allowedNextActions: ['forge_deploy_profile_approve']
    };
  }
  const draft = candidates[0]!;
  const profileHash = await hashDeployProfile(draft);
  return {
    state: 'ready_to_approve',
    draft,
    detected,
    profile_hash: profileHash,
    next_step: 'Ask the user to approve this deploy profile, then call forge_deploy_profile_approve with the draft fields.',
    allowedNextActions: ['forge_deploy_profile_approve']
  };
}
