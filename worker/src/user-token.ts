import { githubUserRequest } from './github';
import type { GitHubRequest } from './contracts';
import type { Env } from './env';
import { ForgeError } from './errors';

/**
 * GitHub user credentials authorize every operation on a human's behalf.
 * GitHub intersects the App's grant with that person's current permissions;
 * installation tokens alone would grant an organization member the App's
 * broader access. Credentials are encrypted at rest and resolved per operation,
 * so reconnecting or rotating a credential updates existing MCP sessions too.
 */

const CONTEXT = 'forge.usertoken.v1';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** Refresh this far ahead of expiry, so a slow call cannot land after it. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface StoredCredential {
  token: string;
  refreshToken: string | null;
  expiresAt: string | null;
  sealedToken: string;
  sealedRefreshToken: string | null;
}

/**
 * Domain-separated from every other use of the signing key. The same secret
 * also signs approval links and access tokens; deriving per purpose means a
 * value from one context can never be verified or decrypted in another.
 */
async function key(env: Env): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${CONTEXT}:${env.FORGE_SIGNING_KEY}`)
  );
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function seal(env: Env, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(env),
    new TextEncoder().encode(plaintext)
  );
  const packed = new Uint8Array(iv.length + sealed.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(sealed), iv.length);
  return btoa(String.fromCharCode(...packed));
}

async function open(env: Env, sealedValue: string): Promise<string | null> {
  try {
    const packed = Uint8Array.from(atob(sealedValue), (character) => character.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: packed.slice(0, 12) },
      await key(env),
      packed.slice(12)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // A rotated signing key makes every stored credential undecryptable. That
    // is a recoverable state — the user signs in again — not an error worth
    // relaying, and the reason must never reach a caller.
    return null;
  }
}

/**
 * Store what GitHub returned at sign-in.
 *
 * A GitHub App with "expire user authorization tokens" enabled returns a
 * refresh token and an eight-hour access token; with it disabled the access
 * token does not expire and there is no refresh token. Both are handled,
 * because which one applies is an App setting rather than something this code
 * can assume.
 */
async function persistCredential(
  env: Env,
  userId: string,
  credential: { token: string; refreshToken?: string | null; expiresInSeconds?: number | null },
  expectedToken: string | null = null
): Promise<boolean> {
  const expiresAt = credential.expiresInSeconds
    ? new Date(Date.now() + credential.expiresInSeconds * 1000).toISOString()
    : null;

  const result = await env.METADATA.prepare(
    `UPDATE users
        SET github_token = ?2, github_refresh_token = ?3, github_token_expires_at = ?4, updated_at = ?5
      WHERE id = ?1 AND (?6 IS NULL OR (github_token = ?6 AND github_refresh_token IS NULL))`
  )
    .bind(
      userId,
      await seal(env, credential.token),
      credential.refreshToken ? await seal(env, credential.refreshToken) : null,
      expiresAt,
      new Date().toISOString(),
      expectedToken
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function storeUserCredential(
  env: Env, userId: string,
  credential: { token: string; refreshToken?: string | null; expiresInSeconds?: number | null }
): Promise<void> {
  await persistCredential(env, userId, credential);
}

async function load(env: Env, userId: string): Promise<StoredCredential | null> {
  const row = await env.METADATA.prepare(
    'SELECT github_token, github_refresh_token, github_token_expires_at FROM users WHERE id = ?1'
  )
    .bind(userId)
    .first<{
      github_token: string | null;
      github_refresh_token: string | null;
      github_token_expires_at: string | null;
    }>();

  if (!row?.github_token) return null;
  const token = await open(env, row.github_token);
  if (!token) return null;

  return {
    token,
    refreshToken: row.github_refresh_token ? await open(env, row.github_refresh_token) : null,
    expiresAt: row.github_token_expires_at,
    sealedToken: row.github_token,
    sealedRefreshToken: row.github_refresh_token
  };
}

function fresh(stored: StoredCredential): boolean {
  if (stored.expiresAt === null) return true;
  const expiry = Date.parse(stored.expiresAt);
  return Number.isFinite(expiry) && expiry - REFRESH_SKEW_MS > Date.now();
}

async function refreshedByAnother(env: Env, userId: string, previous: string): Promise<string | null> {
  const deadline = Date.now() + 6500;
  do {
    const current = await load(env, userId);
    if (!current) return null;
    if (current.sealedToken !== previous && fresh(current)) return current.token;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return null;
}

async function refresh(env: Env, userId: string, stored: StoredCredential): Promise<string | null> {
  if (!stored.refreshToken || !stored.sealedRefreshToken) return refreshedByAnother(env, userId, stored.sealedToken);
  // Atomically consume the encrypted refresh credential before contacting GitHub.
  // Across isolates only one request can spend it; others await its persisted result.
  const claimed = await env.METADATA.prepare(
    `UPDATE users SET github_refresh_token = NULL
      WHERE id = ?1 AND github_token = ?2 AND github_refresh_token = ?3`
  ).bind(userId, stored.sealedToken, stored.sealedRefreshToken).run();
  if ((claimed.meta.changes ?? 0) !== 1) return refreshedByAnother(env, userId, stored.sealedToken);

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Forge-MCP' },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken
    })
  }).catch(() => null);

  const body = (await response?.json().catch(() => null)) as Record<string, unknown> | null;
  const token = typeof body?.access_token === 'string' && body.access_token ? body.access_token : null;
  if (!token) return null;

  // A newer OAuth sign-in must not be overwritten by this older refresh.
  const saved = await persistCredential(env, userId, {
    token,
    refreshToken: typeof body?.refresh_token === 'string' ? body.refresh_token : null,
    expiresInSeconds: typeof body?.expires_in === 'number' ? body.expires_in : null
  }, stored.sealedToken);
  return saved ? token : refreshedByAnother(env, userId, stored.sealedToken);
}

/**
 * A GitHub request authenticated as the human for their requested operation.
 *
 * Failure names the fix: signing in again restores GitHub operations,
 * and prevents requests from acting with broader installation permissions.
 */
export async function userRequestFor(env: Env, userId: string): Promise<GitHubRequest> {
  const stored = await load(env, userId);
  if (!stored) {
    throw new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message:
        'Forge needs you to sign in with GitHub again before it can work on GitHub. ' +
        'Reconnect the Forge app, then ask again.',
      retryable: false
    });
  }

  if (fresh(stored)) return githubUserRequest(env, stored.token);

  const renewed = await refresh(env, userId, stored);
  if (!renewed) {
    throw new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message:
        'Your GitHub sign-in has expired, so Forge cannot work on GitHub for you. ' +
        'Reconnect the Forge app, then ask again.',
      retryable: false
    });
  }
  return githubUserRequest(env, renewed);
}
