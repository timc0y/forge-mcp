import {
  CloudflareCredentialProvider,
  CredentialService,
  MAX_CREDENTIAL_PROFILES_PER_TENANT,
  credentialCipherFromKey,
  type CredentialProfile,
  type CredentialProfileStore,
  type StoredCredentialProfile
} from '@forge/credentials';
import { type CredentialProfileId, type TenantId } from '@forge/core';
import type { Env } from './env';

interface CredentialProfileRow extends Record<string, unknown> {
  id: string; tenant_id: string; name: string; provider: 'cloudflare'; encrypted_secret: string;
  metadata: string; state: 'unvalidated' | 'valid' | 'invalid'; active: number;
  last_validated_at: string | null; created_at: string; updated_at: string;
}

function publicProfile(row: CredentialProfileRow): CredentialProfile {
  return {
    id: row.id as CredentialProfileId, tenantId: row.tenant_id as TenantId, name: row.name,
    provider: row.provider, metadata: JSON.parse(row.metadata) as Record<string, string>, state: row.state,
    active: row.active === 1, ...(row.last_validated_at ? { lastValidatedAt: row.last_validated_at } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function storedProfile(row: CredentialProfileRow): StoredCredentialProfile {
  return { ...publicProfile(row), encryptedSecret: row.encrypted_secret };
}

class D1CredentialProfileStore implements CredentialProfileStore {
  constructor(private readonly db: D1Database) {}

  async create(profile: StoredCredentialProfile): Promise<boolean> {
    const result = await this.db.prepare(`
      INSERT INTO credential_profiles (id, tenant_id, name, provider, encrypted_secret, metadata, state, active, last_validated_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM credential_profiles WHERE tenant_id = ?) < ?
    `).bind(profile.id, profile.tenantId, profile.name, profile.provider, profile.encryptedSecret, JSON.stringify(profile.metadata), profile.state, 0, profile.lastValidatedAt ?? null, profile.createdAt, profile.updatedAt, profile.tenantId, MAX_CREDENTIAL_PROFILES_PER_TENANT).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async list(tenantId: TenantId): Promise<CredentialProfile[]> {
    const result = await this.db.prepare('SELECT * FROM credential_profiles WHERE tenant_id = ? ORDER BY active DESC, created_at ASC').bind(tenantId).all<CredentialProfileRow>();
    return result.results.map(publicProfile);
  }

  async get(tenantId: TenantId, id: CredentialProfileId): Promise<StoredCredentialProfile | null> {
    const row = await this.db.prepare('SELECT * FROM credential_profiles WHERE tenant_id = ? AND id = ?').bind(tenantId, id).first<CredentialProfileRow>();
    return row ? storedProfile(row) : null;
  }

  async update(profile: StoredCredentialProfile): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE credential_profiles SET name = ?, encrypted_secret = ?, metadata = ?, state = ?, active = ?, last_validated_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`).bind(profile.name, profile.encryptedSecret, JSON.stringify(profile.metadata), profile.state, profile.active ? 1 : 0, profile.lastValidatedAt ?? null, profile.updatedAt, profile.tenantId, profile.id).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async delete(tenantId: TenantId, id: CredentialProfileId): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM credential_profiles WHERE tenant_id = ? AND id = ?').bind(tenantId, id).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async setActive(tenantId: TenantId, id: CredentialProfileId): Promise<boolean> {
    const exists = await this.db.prepare('SELECT 1 AS present FROM credential_profiles WHERE tenant_id = ? AND id = ?').bind(tenantId, id).first<{ present: number }>();
    if (!exists) return false;
    await this.db.batch([
      this.db.prepare('UPDATE credential_profiles SET active = 0 WHERE tenant_id = ?').bind(tenantId),
      this.db.prepare('UPDATE credential_profiles SET active = 1, updated_at = ? WHERE tenant_id = ? AND id = ?').bind(new Date().toISOString(), tenantId, id)
    ]);
    return true;
  }
}

export function credentialService(env: Env): CredentialService {
  return new CredentialService(
    new D1CredentialProfileStore(env.METADATA),
    credentialCipherFromKey(env.FORGE_CREDENTIAL_ENCRYPTION_KEY),
    [new CloudflareCredentialProvider()]
  );
}
