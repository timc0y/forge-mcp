import { ForgeError, ids, type CredentialProfileId, type TenantId } from '@forge/core';

export const MAX_CREDENTIAL_PROFILES_PER_TENANT = 5;
export type CredentialProviderKind = 'cloudflare';
export type CredentialProfileState = 'unvalidated' | 'valid' | 'invalid';

export interface CredentialProfile {
  id: CredentialProfileId; tenantId: TenantId; name: string; provider: CredentialProviderKind;
  metadata: Record<string, string>; state: CredentialProfileState; active: boolean;
  lastValidatedAt?: string; createdAt: string; updatedAt: string;
}
export interface StoredCredentialProfile extends CredentialProfile { encryptedSecret: string; }
export interface CreateCredentialProfileInput { tenantId: TenantId; name: string; provider: CredentialProviderKind; secret: string; metadata?: Record<string, string>; active?: boolean; }
export interface UpdateCredentialProfileInput { name?: string; secret?: string; metadata?: Record<string, string>; active?: boolean; }
export interface CredentialProfileStore {
  create(profile: StoredCredentialProfile): Promise<boolean>;
  list(tenantId: TenantId): Promise<CredentialProfile[]>;
  get(tenantId: TenantId, id: CredentialProfileId): Promise<StoredCredentialProfile | null>;
  update(profile: StoredCredentialProfile): Promise<boolean>;
  delete(tenantId: TenantId, id: CredentialProfileId): Promise<boolean>;
  setActive(tenantId: TenantId, id: CredentialProfileId): Promise<boolean>;
}
export interface CredentialProvider {
  readonly kind: CredentialProviderKind;
  normalize(input: { secret: string; metadata?: Record<string, string> }): { secret: string; metadata: Record<string, string> };
  validate(input: { secret: string; metadata: Record<string, string> }): Promise<{ valid: boolean }>;
}
export interface SecretCipher { encrypt(plaintext: string): Promise<string>; decrypt(ciphertext: string): Promise<string>; }
interface CipherEnvelope { v: 1; iv: string; ciphertext: string; }

function base64Url(bytes: Uint8Array): string { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''); }
function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url encoding.');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function credentialCipherFromKey(encodedKey: string): SecretCipher {
  const rawKey = fromBase64Url(encodedKey.trim());
  if (rawKey.byteLength !== 32) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Credential encryption key must be a 32-byte base64url value.', retryable: false });
  const key = crypto.subtle.importKey('raw', Uint8Array.from(rawKey).buffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return {
    async encrypt(plaintext) {
      if (!plaintext) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Credential secret is required.', retryable: false });
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: Uint8Array.from(iv).buffer }, await key, new TextEncoder().encode(plaintext));
      return JSON.stringify({ v: 1, iv: base64Url(iv), ciphertext: base64Url(new Uint8Array(ciphertext)) } satisfies CipherEnvelope);
    },
    async decrypt(value) {
      let envelope: CipherEnvelope;
      try { envelope = JSON.parse(value) as CipherEnvelope; } catch { throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Stored credential cannot be decrypted.', retryable: false }); }
      if (envelope.v !== 1 || !envelope.iv || !envelope.ciphertext) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Stored credential format is unsupported.', retryable: false });
      try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(fromBase64Url(envelope.iv)).buffer }, await key, Uint8Array.from(fromBase64Url(envelope.ciphertext)).buffer)); }
      catch { throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Stored credential cannot be decrypted.', retryable: false }); }
    }
  };
}

export class CloudflareCredentialProvider implements CredentialProvider {
  readonly kind = 'cloudflare' as const;
  normalize(input: { secret: string; metadata?: Record<string, string> }) {
    const secret = input.secret.trim();
    if (secret.length < 16 || secret.length > 4096) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Cloudflare API token is invalid.', retryable: false });
    const accountId = input.metadata?.account_id?.trim();
    if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Cloudflare account_id is invalid.', retryable: false });
    const metadata: Record<string, string> = accountId ? { account_id: accountId } : {};
    return { secret, metadata };
  }
  async validate(input: { secret: string; metadata: Record<string, string> }): Promise<{ valid: boolean }> {
    const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${input.secret}` } });
    if (response.status === 401 || response.status === 403) return { valid: false };
    if (!response.ok) throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: 'Cloudflare could not validate this credential.', retryable: response.status >= 500 });
    return { valid: (await response.json() as { success?: boolean }).success === true };
  }
}

export class CredentialService {
  constructor(private readonly store: CredentialProfileStore, private readonly cipher: SecretCipher, private readonly providers: readonly CredentialProvider[]) {}
  private provider(kind: CredentialProviderKind): CredentialProvider { const provider = this.providers.find((candidate) => candidate.kind === kind); if (!provider) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Credential provider is not configured.', retryable: false }); return provider; }
  async list(tenantId: TenantId): Promise<CredentialProfile[]> { return this.store.list(tenantId); }
  async create(input: CreateCredentialProfileInput): Promise<CredentialProfile> {
    const name = input.name.trim(); if (!name || name.length > 100) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Credential profile name is invalid.', retryable: false });
    const normalized = this.provider(input.provider).normalize({ secret: input.secret, metadata: input.metadata }); const now = new Date().toISOString();
    const profile: StoredCredentialProfile = { id: ids.credentialProfile(), tenantId: input.tenantId, name, provider: input.provider, metadata: normalized.metadata, encryptedSecret: await this.cipher.encrypt(normalized.secret), state: 'unvalidated', active: input.active ?? false, createdAt: now, updatedAt: now };
    if (!await this.store.create(profile)) throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: `A tenant may have at most ${MAX_CREDENTIAL_PROFILES_PER_TENANT} credential profiles.`, retryable: false, details: { maximum_profiles: MAX_CREDENTIAL_PROFILES_PER_TENANT } });
    if (profile.active) await this.store.setActive(input.tenantId, profile.id);
    const { encryptedSecret: _, ...publicProfile } = profile; return publicProfile;
  }
  async update(tenantId: TenantId, id: CredentialProfileId, input: UpdateCredentialProfileInput): Promise<CredentialProfile> {
    const existing = await this.require(tenantId, id); const normalized = this.provider(existing.provider).normalize({ secret: input.secret ?? await this.cipher.decrypt(existing.encryptedSecret), metadata: input.metadata ?? existing.metadata }); const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name || name.length > 100) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Credential profile name is invalid.', retryable: false });
    const changed = input.secret !== undefined || input.metadata !== undefined;
    const profile: StoredCredentialProfile = { ...existing, name, metadata: normalized.metadata, encryptedSecret: input.secret === undefined ? existing.encryptedSecret : await this.cipher.encrypt(normalized.secret), state: changed ? 'unvalidated' : existing.state, lastValidatedAt: changed ? undefined : existing.lastValidatedAt, updatedAt: new Date().toISOString() };
    if (!await this.store.update(profile)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Credential profile was not found.', retryable: false }); if (input.active) await this.store.setActive(tenantId, id);
    const { encryptedSecret: _, ...publicProfile } = profile; return { ...publicProfile, active: input.active ?? publicProfile.active };
  }
  async delete(tenantId: TenantId, id: CredentialProfileId): Promise<void> { if (!await this.store.delete(tenantId, id)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Credential profile was not found.', retryable: false }); }
  async setActive(tenantId: TenantId, id: CredentialProfileId): Promise<CredentialProfile> { if (!await this.store.setActive(tenantId, id)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Credential profile was not found.', retryable: false }); const profile = await this.require(tenantId, id); const { encryptedSecret: _, ...publicProfile } = profile; return { ...publicProfile, active: true }; }
  async validate(tenantId: TenantId, id: CredentialProfileId): Promise<CredentialProfile> { const existing = await this.require(tenantId, id); const result = await this.provider(existing.provider).validate({ secret: await this.cipher.decrypt(existing.encryptedSecret), metadata: existing.metadata }); const profile = { ...existing, state: result.valid ? 'valid' as const : 'invalid' as const, lastValidatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; await this.store.update(profile); const { encryptedSecret: _, ...publicProfile } = profile; return publicProfile; }
  async withSecret<T>(tenantId: TenantId, id: CredentialProfileId, use: (profile: CredentialProfile, secret: string) => Promise<T>): Promise<T> { const profile = await this.require(tenantId, id); const { encryptedSecret, ...publicProfile } = profile; return use(publicProfile, await this.cipher.decrypt(encryptedSecret)); }
  private async require(tenantId: TenantId, id: CredentialProfileId): Promise<StoredCredentialProfile> { const profile = await this.store.get(tenantId, id); if (!profile) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Credential profile was not found.', retryable: false }); return profile; }
}
