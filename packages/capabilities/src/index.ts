import { ForgeError } from '@forge/core';

export interface CapabilityClaims {
  version: 1;
  subject: string;
  tenantId: string;
  workspaceId: string;
  action: string;
  repository?: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
}
async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function parseClaims(value: unknown): CapabilityClaims {
  if (!value || typeof value !== 'object') {
    throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Invalid capability token.', retryable: false });
  }
  const input = value as Record<string, unknown>;
  const requiredStrings = ['subject', 'tenantId', 'workspaceId', 'action', 'nonce'] as const;
  if (
    input.version !== 1 ||
    !requiredStrings.every((name) => typeof input[name] === 'string' && input[name].length > 0) ||
    typeof input.issuedAt !== 'number' ||
    !Number.isSafeInteger(input.issuedAt) ||
    typeof input.expiresAt !== 'number' ||
    !Number.isSafeInteger(input.expiresAt) ||
    (input.repository !== undefined && typeof input.repository !== 'string')
  ) {
    throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Invalid capability token.', retryable: false });
  }
  return input as unknown as CapabilityClaims;
}

export async function issueCapability(claims: CapabilityClaims, secret: string): Promise<string> {
  if (secret.length < 32) throw new Error('Capability signing key must be at least 32 characters.');
  const payload = encode(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), new TextEncoder().encode(payload)));
  return `${payload}.${encode(signature)}`;
}

/**
 * Records a capability nonce as consumed and returns whether it was previously
 * unused. Must return `false` when the nonce has already been claimed so a
 * capability token can only be redeemed once (replay protection).
 *
 * NOTE ON WIRING: this single-use primitive is intentionally NOT applied to the
 * current capability consumers (git clone/fetch and the preview proxy). Each
 * legitimately redeems one capability across multiple HTTP requests within
 * the token's short TTL: Git's smart read protocol and preview page assets.
 * Single-use enforcement would break all of them. Replay for these is bounded
 * by the short expiry + tight (workspace/repo/action/content) scope. `claimNonce`
 * exists for any FUTURE genuinely single-shot capability, which should pass it.
 */
export type ClaimNonce = (
  nonce: string,
  action: string,
  expiresAt: number
) => Promise<boolean>;

export async function verifyCapability(
  token: string,
  secret: string,
  expected: Pick<CapabilityClaims, 'workspaceId' | 'action'> & Partial<Pick<CapabilityClaims, 'repository'>>,
  claimNonce?: ClaimNonce
): Promise<CapabilityClaims> {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Invalid capability token.', retryable: false });
  const valid = await crypto.subtle.verify('HMAC', await key(secret), decode(signature), new TextEncoder().encode(payload));
  if (!valid) throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Invalid capability token.', retryable: false });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decode(payload)));
  } catch {
    throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Invalid capability token.', retryable: false });
  }
  const claims = parseClaims(parsed);
  const now = Math.floor(Date.now() / 1000);
  if (claims.version !== 1 || claims.expiresAt <= now || claims.workspaceId !== expected.workspaceId || claims.action !== expected.action) {
    throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Capability is expired or outside its scope.', retryable: false });
  }
  for (const field of ['repository'] as const) {
    if (expected[field] !== undefined && claims[field] !== expected[field]) {
      throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Capability is expired or outside its scope.', retryable: false });
    }
  }
  // Single-use enforcement: only after the token is fully validated do we
  // consume its nonce, so an unrelated/out-of-scope request never burns it.
  if (claimNonce) {
    const fresh = await claimNonce(claims.nonce, claims.action, claims.expiresAt);
    if (!fresh) {
      throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Capability has already been used.', retryable: false });
    }
  }
  return claims;
}
