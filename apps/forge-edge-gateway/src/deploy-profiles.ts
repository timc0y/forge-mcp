import { hashDeployProfile, type DeployEnvironment, type DeployProfile, type DeployProfileDraft } from '@forge/application';
import { ForgeError, type TenantId } from '@forge/core';

interface DeployProfileRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  provider: 'github';
  owner: string;
  repo: string;
  label: string;
  workflow: 'cloudflare_wrangler';
  environment: DeployEnvironment;
  cwd: string;
  command: string;
  expected_url: string | null;
  expected_worker_name: string | null;
  account_id: string | null;
  map_env: string;
  approved_by: string;
  approved_at: string;
  source_hint: string;
  profile_hash: string;
  state: 'approved' | 'stale' | 'disabled';
  created_at: string;
  updated_at: string;
}

function profileId(): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `dpf_${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

function publicProfile(row: DeployProfileRow): DeployProfile {
  return {
    profile_id: row.id,
    label: row.label,
    repository: { provider: 'github', owner: row.owner, name: row.repo },
    workflow: row.workflow,
    environment: row.environment,
    cwd: row.cwd,
    command: row.command,
    ...(row.expected_url ? { expected_url: row.expected_url } : {}),
    ...(row.expected_worker_name ? { expected_worker_name: row.expected_worker_name } : {}),
    ...(row.account_id ? { account_id: row.account_id } : {}),
    map_env: JSON.parse(row.map_env) as Record<string, string>,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    source_hint: row.source_hint,
    profile_hash: row.profile_hash,
    state: row.state
  };
}

export class DeployProfileStore {
  constructor(private readonly db: D1Database) {}

  async list(tenantId: TenantId, repository: { owner: string; name: string }): Promise<DeployProfile[]> {
    const rows = await this.db.prepare(
      `SELECT * FROM deploy_profiles
       WHERE tenant_id = ? AND provider = 'github' AND owner = ? AND repo = ?
         AND state = 'approved'
       ORDER BY environment DESC, label ASC`
    ).bind(tenantId, repository.owner, repository.name).all<DeployProfileRow>();
    return rows.results.map(publicProfile);
  }

  async get(tenantId: TenantId, id: string): Promise<DeployProfile> {
    const row = await this.db.prepare(
      `SELECT * FROM deploy_profiles WHERE tenant_id = ? AND id = ?`
    ).bind(tenantId, id).first<DeployProfileRow>();
    if (!row) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: 'Deploy profile not found. Call forge_deploy_profiles for the repository/workspace, or call forge_deploy_profile_plan to create one.',
        retryable: false,
        details: { allowedNextActions: ['forge_deploy_profiles', 'forge_deploy_profile_plan'] }
      });
    }
    return publicProfile(row);
  }

  async saveApproved(tenantId: TenantId, draft: DeployProfileDraft, approvedBy: string): Promise<DeployProfile> {
    const now = new Date().toISOString();
    const profileHash = await hashDeployProfile(draft);
    const existing = await this.db.prepare(
      `SELECT id FROM deploy_profiles
       WHERE tenant_id = ? AND provider = 'github' AND owner = ? AND repo = ? AND label = ?`
    ).bind(tenantId, draft.repository.owner, draft.repository.name, draft.label).first<{ id: string }>();
    const id = existing?.id ?? profileId();
    if (existing) {
      await this.db.prepare(
        `UPDATE deploy_profiles
         SET workflow = ?, environment = ?, cwd = ?, command = ?, expected_url = ?, expected_worker_name = ?,
             account_id = ?, map_env = ?, approved_by = ?, approved_at = ?, source_hint = ?, profile_hash = ?,
             state = 'approved', updated_at = ?
         WHERE tenant_id = ? AND id = ?`
      ).bind(
        draft.workflow, draft.environment, draft.cwd, draft.command, draft.expected_url ?? null,
        draft.expected_worker_name ?? null, draft.account_id ?? null, JSON.stringify(draft.map_env),
        approvedBy, now, draft.source_hint, profileHash, now, tenantId, id
      ).run();
    } else {
      await this.db.prepare(
        `INSERT INTO deploy_profiles
         (id, tenant_id, provider, owner, repo, label, workflow, environment, cwd, command, expected_url,
          expected_worker_name, account_id, map_env, approved_by, approved_at, source_hint, profile_hash,
          state, created_at, updated_at)
         VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`
      ).bind(
        id, tenantId, draft.repository.owner, draft.repository.name, draft.label, draft.workflow,
        draft.environment, draft.cwd, draft.command, draft.expected_url ?? null, draft.expected_worker_name ?? null,
        draft.account_id ?? null, JSON.stringify(draft.map_env), approvedBy, now, draft.source_hint,
        profileHash, now, now
      ).run();
    }
    return await this.get(tenantId, id);
  }
}

export function deployProfileStore(db: D1Database): DeployProfileStore {
  return new DeployProfileStore(db);
}
