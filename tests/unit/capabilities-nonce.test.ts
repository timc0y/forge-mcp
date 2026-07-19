import { describe, expect, it } from 'vitest';
import { issueCapability, verifyCapability, type CapabilityClaims } from '@forge/capabilities';
import { D1CapabilityNonceStore } from '../../packages/metadata-d1/src/index';
import { redirectUriAllowed } from '../../apps/forge-edge-gateway/src/oauth';
import type { Env } from '../../apps/forge-edge-gateway/src/env';

const secret = 'this-is-a-development-test-secret-with-32-bytes';
function claims(nonce = 'nonce_1', expiresAt = Math.floor(Date.now() / 1000) + 60): CapabilityClaims {
  return {
    version: 1,
    subject: 'user_1',
    tenantId: 'ten_1',
    workspaceId: 'ws_0123456789abcdefghjkmnpq',
    action: 'preview.read',
    nonce,
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt
  };
}

// Minimal in-memory D1 understanding only the statements D1CapabilityNonceStore
// issues: an INSERT ... ON CONFLICT DO NOTHING and a DELETE by expires_at.
interface NonceRow {
  nonce: string;
  action: string;
  expires_at: string;
  seen_at: string;
}
function fakeD1(rows: NonceRow[] = []) {
  return {
    rows,
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...input: unknown[]) {
          values = input;
          return this;
        },
        async run() {
          if (sql.startsWith('INSERT INTO capability_nonces')) {
            const [nonce, action, expires_at, seen_at] = values as [string, string, string, string];
            if (rows.some((r) => r.nonce === nonce)) return { meta: { changes: 0 } };
            rows.push({ nonce, action, expires_at, seen_at });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('DELETE FROM capability_nonces')) {
            const now = values[0] as string;
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (rows[i]!.expires_at <= now) rows.splice(i, 1);
            }
            return { meta: { changes: before - rows.length } };
          }
          return { meta: { changes: 0 } };
        }
      };
    }
  } as unknown as D1Database & { rows: NonceRow[] };
}

describe('capability nonce store', () => {
  it('allows the first claim and rejects a replay', async () => {
    const store = new D1CapabilityNonceStore(fakeD1());
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(await store.claim('nonce_a', 'preview.read', expiresAt)).toBe(true);
    expect(await store.claim('nonce_a', 'preview.read', expiresAt)).toBe(false);
  });

  it('prunes only expired rows', async () => {
    const db = fakeD1();
    const store = new D1CapabilityNonceStore(db);
    await store.claim('expired', 'a', '2020-01-01T00:00:00.000Z');
    await store.claim('fresh', 'a', new Date(Date.now() + 60_000).toISOString());
    const removed = await store.pruneExpired();
    expect(removed).toBe(1);
    expect(db.rows.map((r) => r.nonce)).toEqual(['fresh']);
  });
});

describe('capability single-use verification', () => {
  it('rejects a second verification of the same token', async () => {
    const store = new D1CapabilityNonceStore(fakeD1());
    const claim = (nonce: string, _action: string, expiresAt: number): Promise<boolean> =>
      store.claim(nonce, _action, new Date(expiresAt * 1000).toISOString());
    const token = await issueCapability(claims('nonce_single'), secret);
    const expected = { workspaceId: claims().workspaceId, action: 'preview.read' };

    const verified = await verifyCapability(token, secret, expected, claim);
    expect(verified.subject).toBe('user_1');

    await expect(verifyCapability(token, secret, expected, claim)).rejects.toMatchObject({
      code: 'FORGE_PERMISSION_DENIED'
    });
  });
});

describe('DCR loopback redirect gating', () => {
  it('rejects loopback redirect URIs in production but allows them otherwise', () => {
    const prod = { FORGE_ENVIRONMENT: 'production' } as unknown as Env;
    const dev = { FORGE_ENVIRONMENT: 'development' } as unknown as Env;
    expect(redirectUriAllowed('http://127.0.0.1/callback', prod)).toBe(false);
    expect(redirectUriAllowed('http://localhost/callback', prod)).toBe(false);
    expect(redirectUriAllowed('http://127.0.0.1/callback', dev)).toBe(true);
    // A legitimate production redirect target still passes.
    expect(redirectUriAllowed('https://claude.ai/callback', prod)).toBe(true);
  });
});
