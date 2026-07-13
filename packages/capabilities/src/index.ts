import { ForgeError } from '@forge/core';

export interface CapabilityClaims {
  version: 1;
  subject: string;
  tenantId: string;
  workspaceId: string;
  action: string;
  repository?: string;
  branchPattern?: string;
  gitCommit?: string;
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
    (input.repository !== undefined && typeof input.repository !== 'string') ||
    (input.branchPattern !== undefined && typeof input.branchPattern !== 'string') ||
    (input.gitCommit !== undefined && (typeof input.gitCommit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(input.gitCommit)))
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

export async function verifyCapability(
  token: string,
  secret: string,
  expected: Pick<CapabilityClaims, 'workspaceId' | 'action'> & Partial<Pick<CapabilityClaims, 'repository' | 'branchPattern' | 'gitCommit'>>
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
  for (const field of ['repository', 'branchPattern', 'gitCommit'] as const) {
    if (expected[field] !== undefined && claims[field] !== expected[field]) {
      throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Capability is expired or outside its scope.', retryable: false });
    }
  }
  return claims;
}
