import { credentialCipherFromKey, type SecretCipher } from '@forge/credentials';
import { ids, type SecretId, type TenantId, type WorkspaceId } from '@forge/core';
import type { Env } from './env';

export const MAX_SECRETS_PER_TENANT = 20;

interface VaultSecret {
  id: SecretId;
  tenantId: TenantId;
  label: string;
  provider: 'cloudflare' | 'shopify' | 'generic';
  varNames: string[];
  metadata: Record<string, string>;
  state: 'unvalidated' | 'valid' | 'invalid';
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredVaultSecret extends VaultSecret {
  encryptedVars: string;
}

interface SecretAttachment {
  workspaceId: string;
  secretId: SecretId;
  tenantId: TenantId;
  attachedAt: string;
}

interface SecretRow extends Record<string, unknown> {
  id: string; tenant_id: string; label: string; provider: 'cloudflare' | 'shopify' | 'generic';
  encrypted_vars: string; metadata: string; state: 'unvalidated' | 'valid' | 'invalid';
  last_validated_at: string | null; created_at: string; updated_at: string;
}

interface AttachmentRow extends Record<string, unknown> {
  workspace_id: string; secret_id: string; tenant_id: string; attached_at: string;
}

function publicSecret(row: SecretRow, varNames: string[]): VaultSecret {
  return {
    id: row.id as SecretId, tenantId: row.tenant_id as TenantId, label: row.label,
    provider: row.provider, varNames,
    metadata: JSON.parse(row.metadata) as Record<string, string>, state: row.state,
    ...(row.last_validated_at ? { lastValidatedAt: row.last_validated_at } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export class VaultService {
  constructor(
    private readonly db: D1Database,
    private readonly cipher: SecretCipher
  ) {}

  async list(tenantId: TenantId): Promise<VaultSecret[]> {
    const result = await this.db.prepare(
      'SELECT * FROM secrets WHERE tenant_id = ? ORDER BY created_at ASC'
    ).bind(tenantId).all<SecretRow>();
    const secrets: VaultSecret[] = [];
    for (const row of result.results) {
      const vars = await this.decryptVars(row.encrypted_vars);
      secrets.push(publicSecret(row, Object.keys(vars ?? {})));
    }
    return secrets;
  }

  async create(
    tenantId: TenantId,
    label: string,
    provider: 'cloudflare' | 'shopify' | 'generic',
    env: Record<string, string>
  ): Promise<VaultSecret> {
    const trimmed = label.trim();
    if (!trimmed || trimmed.length > 100) throw new Error('Secret label must be between 1 and 100 characters.');
    if (Object.keys(env).length === 0) throw new Error('At least one environment variable is required.');
    for (const key of Object.keys(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable name: "${key}". Must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
      }
    }
    const now = new Date().toISOString();
    const id = ids.secret();
    const encryptedVars = await this.cipher.encrypt(JSON.stringify(env));
    const result = await this.db.prepare(`
      INSERT INTO secrets (id, tenant_id, label, provider, encrypted_vars, metadata, state, last_validated_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, '{}', 'unvalidated', ?, ?, ?
      WHERE (SELECT COUNT(*) FROM secrets WHERE tenant_id = ?) < ?
    `).bind(id, tenantId, trimmed, provider, encryptedVars, null, now, now, tenantId, MAX_SECRETS_PER_TENANT).run();
    if ((result.meta.changes ?? 0) !== 1) {
      const exists = await this.db.prepare(
        'SELECT 1 AS present FROM secrets WHERE tenant_id = ? AND label = ?'
      ).bind(tenantId, trimmed).first<{ present: number }>();
      if (exists) throw new Error(`A secret with the label "${trimmed}" already exists.`);
      throw new Error('Secret quota exceeded. A tenant may have at most ' + MAX_SECRETS_PER_TENANT + ' secrets.');
    }
    return publicSecret({ id, tenant_id: tenantId, label: trimmed, provider, encrypted_vars: encryptedVars, metadata: '{}', state: 'unvalidated', last_validated_at: null, created_at: now, updated_at: now }, Object.keys(env));
  }

  async update(
    tenantId: TenantId,
    id: SecretId,
    changes: { label?: string; provider?: 'cloudflare' | 'shopify' | 'generic'; env?: Record<string, string> }
  ): Promise<VaultSecret> {
    const row = await this.require(tenantId, id);
    const currentVars = await this.decryptVars(row.encrypted_vars) ?? {};
    const label = changes.label !== undefined ? changes.label.trim() : row.label;
    if (!label || label.length > 100) throw new Error('Secret label must be between 1 and 100 characters.');
    const provider = changes.provider ?? row.provider;
    const env = changes.env ?? currentVars;
    if (Object.keys(env).length === 0) throw new Error('At least one environment variable is required.');
    for (const key of Object.keys(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable name: "${key}".`);
      }
    }
    const now = new Date().toISOString();
    const encryptedVars = await this.cipher.encrypt(JSON.stringify(env));
    const state = changes.env !== undefined ? 'unvalidated' : row.state;
    await this.db.prepare(
      'UPDATE secrets SET label = ?, provider = ?, encrypted_vars = ?, state = ?, updated_at = ? WHERE tenant_id = ? AND id = ?'
    ).bind(label, provider, encryptedVars, state, now, tenantId, id).run();
    return publicSecret({ ...row, label, provider, encrypted_vars: encryptedVars, state, updated_at: now }, Object.keys(env));
  }

  async delete(tenantId: TenantId, id: SecretId): Promise<void> {
    const result = await this.db.prepare(
      'DELETE FROM secrets WHERE tenant_id = ? AND id = ?'
    ).bind(tenantId, id).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('Secret not found.');
  }

  async attach(tenantId: TenantId, secretId: SecretId, workspaceId: string): Promise<void> {
    await this.require(tenantId, secretId);
    const now = new Date().toISOString();
    await this.db.prepare(
      'INSERT OR IGNORE INTO attached_workspace_secrets (workspace_id, secret_id, tenant_id, attached_at) VALUES (?, ?, ?, ?)'
    ).bind(workspaceId, secretId, tenantId, now).run();
  }

  async detach(tenantId: TenantId, secretId: SecretId, workspaceId: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM attached_workspace_secrets WHERE workspace_id = ? AND secret_id = ? AND tenant_id = ?'
    ).bind(workspaceId, secretId, tenantId).run();
  }

  async attachedSecrets(tenantId: TenantId): Promise<SecretAttachment[]> {
    const result = await this.db.prepare(
      'SELECT * FROM attached_workspace_secrets WHERE tenant_id = ? ORDER BY attached_at ASC'
    ).bind(tenantId).all<AttachmentRow>();
    return result.results.map((row) => ({
      workspaceId: row.workspace_id, secretId: row.secret_id as SecretId,
      tenantId: row.tenant_id as TenantId, attachedAt: row.attached_at
    }));
  }

  async decodeVars(tenantId: TenantId, secretId: SecretId): Promise<Record<string, string>> {
    const row = await this.require(tenantId, secretId);
    return await this.decryptVars(row.encrypted_vars) ?? {};
  }

  async attachedEnv(tenantId: TenantId, workspaceId: string): Promise<{ vars: Record<string, string>; redact: Set<string> }> {
    const rows = await this.db.prepare(
      'SELECT secret_id FROM attached_workspace_secrets WHERE workspace_id = ? AND tenant_id = ?'
    ).bind(workspaceId, tenantId).all<{ secret_id: string }>();
    const allVars: Record<string, string> = {};
    const redact = new Set<string>();
    for (const row of rows.results) {
      const vars = await this.decodeVars(tenantId, row.secret_id as SecretId);
      for (const [key, value] of Object.entries(vars)) {
        if (!(key in allVars)) {
          allVars[key] = value;
          redact.add(value);
        }
      }
    }
    return { vars: allVars, redact };
  }

  async redactOutput(output: string, tenantId: TenantId, workspaceId: string): Promise<string> {
    const { redact } = await this.attachedEnv(tenantId, workspaceId);
    let result = output;
    for (const value of redact) {
      if (value.length >= 4) result = result.replaceAll(value, '[REDACTED]');
    }
    return result;
  }

  private async require(tenantId: TenantId, id: SecretId): Promise<SecretRow> {
    const row = await this.db.prepare(
      'SELECT * FROM secrets WHERE tenant_id = ? AND id = ?'
    ).bind(tenantId, id).first<SecretRow>();
    if (!row) throw new Error('Secret not found.');
    return row;
  }

  private async decryptVars(encryptedVars: string): Promise<Record<string, string> | null> {
    try {
      const raw = await this.cipher.decrypt(encryptedVars);
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return null;
    }
  }
}

export function vaultService(env: Env): VaultService {
  return new VaultService(
    env.METADATA,
    credentialCipherFromKey(env.FORGE_CREDENTIAL_ENCRYPTION_KEY)
  );
}
