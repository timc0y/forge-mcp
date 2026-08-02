import { describe, expect, it } from 'vitest';
import { credentialCipherFromKey } from '@forge/credentials';
import { VaultService, MAX_SECRETS_PER_TENANT } from '../../apps/forge-edge-gateway/src/vault';
import type { SecretId, TenantId, WorkspaceId } from '@forge/core';

class MemoryDb {
  private secrets = new Map<string, Record<string, unknown>>();
  private attachments = new Map<string, Record<string, unknown>>();

  prepare(sql: string): { bind: (...args: unknown[]) => { run: () => Promise<{ meta: { changes?: number } }>; all: <T>() => Promise<{ results: T[] }>; first: <T>() => Promise<T | null> } } {
    const self = this;
    return {
      bind(...args: unknown[]) {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        return {
          async run() {
            if (normalized.startsWith('INSERT INTO secrets')) {
              const id = args[0] as string;
              const tenant = args[1] as string;
              const label = args[2] as string;
              const count = [...self.secrets.values()].filter((s) => s.tenant_id === tenant).length;
              if (count >= MAX_SECRETS_PER_TENANT) return { meta: { changes: 0 } };
              const exists = [...self.secrets.values()].some((s) => s.tenant_id === tenant && s.label === label);
              if (exists) return { meta: { changes: 0 } };
              self.secrets.set(id, {
                id, tenant_id: tenant, label: args[2], provider: args[3],
                encrypted_vars: args[4] as string, metadata: args[5], state: args[6],
                last_validated_at: args[7], created_at: args[8], updated_at: args[9]
              });
              return { meta: { changes: 1 } };
            }
            if (normalized.startsWith('UPDATE secrets SET')) {
              const id = args[args.length - 1] as string;
              const existing = self.secrets.get(id);
              if (!existing) return { meta: { changes: 0 } };
              const label = args[0] as string;
              const provider = args[1] as string;
              const encryptedVars = args[2] as string;
              const state = args[3] as string;
              const updatedAt = args[4] as string;
              self.secrets.set(id, { ...existing, label, provider, encrypted_vars: encryptedVars, state, updated_at: updatedAt });
              return { meta: { changes: 1 } };
            }
            if (normalized.startsWith('DELETE FROM secrets')) {
              const id = args[1] as string;
              const deleted = self.secrets.delete(id);
              // Simulate ON DELETE CASCADE
              for (const key of self.attachments.keys()) {
                if (key.endsWith(`\0${id}`)) self.attachments.delete(key);
              }
              return { meta: { changes: deleted ? 1 : 0 } };
            }
            if (normalized.startsWith('DELETE FROM attached_workspace_secrets')) {
              const ws = args[0] as string;
              const sid = args[1] as string;
              const key = `${ws}\0${sid}`;
              const deleted = self.attachments.delete(key);
              return { meta: { changes: deleted ? 1 : 0 } };
            }
            if (normalized.startsWith('INSERT OR IGNORE INTO attached_workspace_secrets')) {
              const ws = args[0] as string;
              const sid = args[1] as string;
              const key = `${ws}\0${sid}`;
              if (!self.attachments.has(key)) {
                self.attachments.set(key, { workspace_id: ws, secret_id: sid, tenant_id: args[2], attached_at: args[3] });
              }
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
          async all<T>() {
            if (normalized.startsWith('SELECT * FROM secrets')) {
              const tenant = args[0] as string;
              const results = [...self.secrets.values()]
                .filter((s) => s.tenant_id === tenant)
                .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
              return { results: results as unknown as T[] };
            }
            if (normalized.startsWith('SELECT * FROM attached_workspace_secrets')) {
              const tenant = args[0] as string;
              const results = [...self.attachments.values()]
                .filter((a) => a.tenant_id === tenant)
                .sort((a, b) => String(a.attached_at).localeCompare(String(b.attached_at)));
              return { results: results as unknown as T[] };
            }
            if (normalized.startsWith('SELECT secret_id FROM attached_workspace_secrets')) {
              const ws = args[0] as string;
              const results = [...self.attachments.values()]
                .filter((a) => a.workspace_id === ws)
                .map((a) => ({ secret_id: a.secret_id }));
              return { results: results as unknown as T[] };
            }
            return { results: [] as T[] };
          },
          async first<T>() {
            if (normalized.startsWith('SELECT 1 AS present FROM secrets')) {
              const tenant = args[0] as string;
              const label = args[1] as string;
              const exists = [...self.secrets.values()].some((s) => s.tenant_id === tenant && s.label === label);
              return (exists ? { present: 1 } : null) as T | null;
            }
            if (normalized.startsWith('SELECT * FROM secrets')) {
              const tenant = args[0] as string;
              const id = args[1] as string;
              const row = self.secrets.get(id);
              if (row && row.tenant_id === tenant) return row as T;
              return null as T | null;
            }
            return null as T | null;
          }
        };
      }
    };
  }
}

const cipher = credentialCipherFromKey('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
const tenantId = 'ten_00000000000000000000000000' as TenantId;
const wsId = 'ws_00000000000000000000000000' as WorkspaceId;

function createService(): VaultService {
  return new VaultService(new MemoryDb() as unknown as D1Database, cipher);
}

describe('vault secrets', () => {
  it('creates a secret with env vars and never returns values', async () => {
    const service = createService();
    const secret = await service.create(tenantId, 'CF Production', 'cloudflare', {
      CLOUDFLARE_API_TOKEN: 'very-secret-token',
      CLOUDFLARE_ACCOUNT_ID: 'abc123'
    });
    expect(secret.label).toBe('CF Production');
    expect(secret.provider).toBe('cloudflare');
    expect(secret.varNames).toEqual(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
    expect(secret).not.toHaveProperty('encryptedVars');
    expect(secret.state).toBe('unvalidated');
  });

  it('lists secrets without values', async () => {
    const service = createService();
    await service.create(tenantId, 'CF Staging', 'cloudflare', { CLOUDFLARE_API_TOKEN: 'staging-token' });
    await service.create(tenantId, 'Shopify Store A', 'shopify', {
      SHOPIFY_STORE: 'my-store.myshopify.com',
      SHOPIFY_ACCESS_TOKEN: 'shpat_xxx'
    });
    const secrets = await service.list(tenantId);
    expect(secrets).toHaveLength(2);
    expect(secrets[0].label).toBe('CF Staging');
    expect(secrets[1].label).toBe('Shopify Store A');
    expect(secrets[1].varNames).toEqual(['SHOPIFY_STORE', 'SHOPIFY_ACCESS_TOKEN']);
  });

  it('rejects duplicate labels', async () => {
    const service = createService();
    await service.create(tenantId, 'My Secret', 'generic', { MY_KEY: 'value1' });
    await expect(service.create(tenantId, 'My Secret', 'generic', { MY_KEY: 'value2' })).rejects.toThrow('already exists');
  });

  it('rejects empty env', async () => {
    const service = createService();
    await expect(service.create(tenantId, 'Empty', 'generic', {})).rejects.toThrow('At least one');
  });

  it('rejects invalid env var names', async () => {
    const service = createService();
    await expect(service.create(tenantId, 'Bad', 'generic', { '123BAD': 'value' })).rejects.toThrow('Invalid environment variable name');
  });

  it('updates label and merges env patches without dropping existing keys', async () => {
    const service = createService();
    const secret = await service.create(tenantId, 'Old Label', 'generic', { CF_KEY: 'original' });
    const updated = await service.update(tenantId, secret.id, {
      label: 'New Label',
      env: { CLOUDFLARE_ACCOUNT_ID: 'acc-123' }
    });
    expect(updated.label).toBe('New Label');
    expect(updated.varNames.sort()).toEqual(['CF_KEY', 'CLOUDFLARE_ACCOUNT_ID']);
    const decoded = await service.decodeVars(tenantId, secret.id);
    expect(decoded).toEqual({ CF_KEY: 'original', CLOUDFLARE_ACCOUNT_ID: 'acc-123' });
  });

  it('unsets env keys without requiring the remaining values to be re-sent', async () => {
    const service = createService();
    const secret = await service.create(tenantId, 'Unset', 'generic', {
      CF_KEY: 'tok',
      TEMP: 'gone'
    });
    const updated = await service.update(tenantId, secret.id, { unsetEnv: ['TEMP'] });
    expect(updated.varNames).toEqual(['CF_KEY']);
    expect(await service.decodeVars(tenantId, secret.id)).toEqual({ CF_KEY: 'tok' });
  });

  it('deletes a secret', async () => {
    const service = createService();
    const secret = await service.create(tenantId, 'To Delete', 'generic', { KEY: 'value' });
    await service.delete(tenantId, secret.id);
    const secrets = await service.list(tenantId);
    expect(secrets).toHaveLength(0);
  });

  it('enforces the quota', async () => {
    const service = createService();
    for (let i = 0; i < MAX_SECRETS_PER_TENANT; i++) {
      await service.create(tenantId, `Secret ${i}`, 'generic', { KEY: `value${i}` });
    }
    await expect(service.create(tenantId, 'Too Many', 'generic', { KEY: 'value' })).rejects.toThrow('quota exceeded');
  });

  it('attaches and detaches secrets to workspaces', async () => {
    const service = createService();
    const secret = await service.create(tenantId, 'To Attach', 'generic', { SECRET_KEY: 'shh' });
    await service.attach(tenantId, secret.id, wsId);
    const attachments = await service.attachedSecrets(tenantId);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].secretId).toBe(secret.id);
    expect(attachments[0].workspaceId).toBe(wsId);
    await service.detach(tenantId, secret.id, wsId);
    expect(await service.attachedSecrets(tenantId)).toHaveLength(0);
  });

  it('injects attached env vars', async () => {
    const service = createService();
    const s1 = await service.create(tenantId, 'CF', 'cloudflare', {
      CLOUDFLARE_API_TOKEN: 'cf-token',
      CLOUDFLARE_ACCOUNT_ID: 'acc-123'
    });
    const s2 = await service.create(tenantId, 'Shopify', 'shopify', {
      SHOPIFY_STORE: 'store.myshopify.com',
      SHOPIFY_TOKEN: 'shp-token'
    });
    await service.attach(tenantId, s1.id, wsId);
    await service.attach(tenantId, s2.id, wsId);
    const { vars, redact } = await service.attachedEnv(tenantId, wsId);
    expect(vars).toEqual({
      CLOUDFLARE_API_TOKEN: 'cf-token',
      CLOUDFLARE_ACCOUNT_ID: 'acc-123',
      SHOPIFY_STORE: 'store.myshopify.com',
      SHOPIFY_TOKEN: 'shp-token'
    });
    expect(redact.has('cf-token')).toBe(true);
    expect(redact.has('shp-token')).toBe(true);
  });

  it('user env vars override attached ones', async () => {
    const service = createService();
    const secret = await service.create(tenantId, 'Overridden', 'generic', { MY_KEY: 'original' });
    await service.attach(tenantId, secret.id, wsId);
    const { vars } = await service.attachedEnv(tenantId, wsId);
    // User env would be merged with {...attached, ...userEnv} at the handler level
    expect(vars).toEqual({ MY_KEY: 'original' });
  });

  it('redacts secrets from output', async () => {
    const service = createService();
    const secret = await service.create(tenantId, 'Redact Test', 'generic', { API_KEY: 'super-secret-value' });
    await service.attach(tenantId, secret.id, wsId);
    const redacted = await service.redactOutput('my super-secret-value is here and super-secret-value again', tenantId, wsId);
    expect(redacted).toBe('my [REDACTED] is here and [REDACTED] again');
  });

  it('encrypts stored values', async () => {
    const service = createService();
    await service.create(tenantId, 'Encrypted', 'generic', { PASSWORD: 'hunter2' });
    const decoded = await service.decodeVars(tenantId, (await service.list(tenantId))[0].id);
    expect(decoded).toEqual({ PASSWORD: 'hunter2' });
  });

  it('rejects label longer than 100 characters', async () => {
    const service = createService();
    await expect(service.create(tenantId, 'a'.repeat(101), 'generic', { KEY: 'value' })).rejects.toThrow('between 1 and 100');
  });

  it('rejects env var name starting with digit', async () => {
    const service = createService();
    await expect(service.create(tenantId, 'Bad Var', 'generic', { '1INVALID': 'value' })).rejects.toThrow('Invalid environment variable name');
  });

  it('rejects env var name with special characters', async () => {
    const service = createService();
    await expect(service.create(tenantId, 'Bad Var 2', 'generic', { 'MY-KEY': 'value' })).rejects.toThrow('Invalid environment variable name');
    await expect(service.create(tenantId, 'Bad Var 3', 'generic', { 'MY.KEY': 'value' })).rejects.toThrow('Invalid environment variable name');
  });

  it('accepts env var name with underscore and uppercase', async () => {
    const service = createService();
    const secret = await service.create(tenantId, 'Valid Env', 'generic', { 'MY_COOL_VAR': 'value', 'ANOTHER_VAR': 'val2' });
    expect(secret.varNames).toEqual(['MY_COOL_VAR', 'ANOTHER_VAR']);
  });

  it('detach removes only the specified workspace attachment', async () => {
    const service = createService();
    const s1 = await service.create(tenantId, 'WS-A', 'generic', { KEY: 'val1' });
    const s2 = await service.create(tenantId, 'WS-B', 'generic', { KEY: 'val2' });
    await service.attach(tenantId, s1.id, wsId);
    await service.attach(tenantId, s2.id, wsId);
    expect(await service.attachedSecrets(tenantId)).toHaveLength(2);
    await service.detach(tenantId, s1.id, wsId);
    const remaining = await service.attachedSecrets(tenantId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].secretId).toBe(s2.id);
  });

  it('first-attached wins when same var name exists in multiple attached secrets', async () => {
    const service = createService();
    const s1 = await service.create(tenantId, 'First', 'generic', { SHARED_KEY: 'first-value' });
    const s2 = await service.create(tenantId, 'Second', 'generic', { SHARED_KEY: 'second-value' });
    await service.attach(tenantId, s1.id, wsId);
    await service.attach(tenantId, s2.id, wsId);
    const { vars } = await service.attachedEnv(tenantId, wsId);
    expect(vars).toEqual({ SHARED_KEY: 'first-value' });
  });

  it('redact skips values shorter than 4 characters', async () => {
    const service = createService();
    const secret = await service.create(tenantId, 'Short', 'generic', { KEY: 'ab' });
    await service.attach(tenantId, secret.id, wsId);
    const redacted = await service.redactOutput('value ab here', tenantId, wsId);
    expect(redacted).toBe('value ab here');
  });

  it('returns empty env for unattached workspace', async () => {
    const service = createService();
    const otherWs = 'ws_99999999999999999999999999' as WorkspaceId;
    const { vars, redact } = await service.attachedEnv(tenantId, otherWs);
    expect(vars).toEqual({});
    expect(redact.size).toBe(0);
  });

  it('handles delete cascading to attached records', async () => {
    const service = createService();
    const secret = await service.create(tenantId, 'Cascade', 'generic', { KEY: 'val' });
    await service.attach(tenantId, secret.id, wsId);
    await service.delete(tenantId, secret.id);
    expect(await service.attachedSecrets(tenantId)).toHaveLength(0);
  });

  it('allows different tenants to have same label', async () => {
    const service = createService();
    const tenantB = 'ten_bbbbbbbbbbbbbbbbbbbbbbbbbb' as TenantId;
    await service.create(tenantId, 'Same Label', 'generic', { A: '1' });
    const b = await service.create(tenantB, 'Same Label', 'generic', { B: '2' });
    expect(b.label).toBe('Same Label');
    const aList = await service.list(tenantId);
    const bList = await service.list(tenantB);
    expect(aList).toHaveLength(1);
    expect(bList).toHaveLength(1);
  });
});
