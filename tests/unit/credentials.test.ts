import { describe, expect, it } from 'vitest';
import {
  CredentialService,
  MAX_CREDENTIAL_PROFILES_PER_TENANT,
  credentialCipherFromKey,
  type CredentialProfile,
  type CredentialProfileStore,
  type StoredCredentialProfile
} from '@forge/credentials';
import type { CredentialProfileId, TenantId } from '@forge/core';

class MemoryStore implements CredentialProfileStore {
  private readonly values = new Map<string, StoredCredentialProfile>();
  async create(profile: StoredCredentialProfile) { if ([...this.values.values()].filter((value) => value.tenantId === profile.tenantId).length >= MAX_CREDENTIAL_PROFILES_PER_TENANT) return false; this.values.set(profile.id, profile); return true; }
  async list(tenantId: TenantId): Promise<CredentialProfile[]> { return [...this.values.values()].filter((value) => value.tenantId === tenantId).map(({ encryptedSecret: _, ...profile }) => profile); }
  async get(tenantId: TenantId, id: CredentialProfileId) { const profile = this.values.get(id); return profile?.tenantId === tenantId ? profile : null; }
  async update(profile: StoredCredentialProfile) { if (!this.values.has(profile.id)) return false; this.values.set(profile.id, profile); return true; }
  async delete(tenantId: TenantId, id: CredentialProfileId) { const profile = await this.get(tenantId, id); if (!profile) return false; this.values.delete(id); return true; }
  async setActive(tenantId: TenantId, id: CredentialProfileId) { if (!await this.get(tenantId, id)) return false; for (const profile of this.values.values()) if (profile.tenantId === tenantId) profile.active = profile.id === id; return true; }
  raw(id: CredentialProfileId) { return this.values.get(id); }
}

const provider = {
  kind: 'cloudflare' as const,
  normalize: ({ secret, metadata }: { secret: string; metadata?: Record<string, string> }) => ({ secret: secret.trim(), metadata: metadata ?? {} }),
  validate: async ({ secret }: { secret: string; metadata: Record<string, string> }) => ({ valid: secret === 'very-secret-token' })
};

describe('credential profiles', () => {
  it('encrypts secrets before storage and never returns them in profile results', async () => {
    const store = new MemoryStore();
    const service = new CredentialService(store, credentialCipherFromKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), [provider]);
    const tenantId = 'ten_00000000000000000000000000' as TenantId;
    const profile = await service.create({ tenantId, name: 'Production Cloudflare', provider: 'cloudflare', secret: 'very-secret-token', active: true });
    expect(profile).not.toHaveProperty('encryptedSecret');
    expect(JSON.stringify(store.raw(profile.id))).not.toContain('very-secret-token');
    expect(await service.list(tenantId)).toEqual([profile]);
    expect((await service.validate(tenantId, profile.id)).state).toBe('valid');
  });

  it('enforces the five-profile tenant limit', async () => {
    const service = new CredentialService(new MemoryStore(), credentialCipherFromKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), [provider]);
    const tenantId = 'ten_00000000000000000000000000' as TenantId;
    for (let index = 0; index < MAX_CREDENTIAL_PROFILES_PER_TENANT; index += 1) await service.create({ tenantId, name: `Profile ${index}`, provider: 'cloudflare', secret: 'very-secret-token' });
    await expect(service.create({ tenantId, name: 'Too many', provider: 'cloudflare', secret: 'very-secret-token' })).rejects.toMatchObject({ code: 'FORGE_QUOTA_EXCEEDED' });
  });
});
