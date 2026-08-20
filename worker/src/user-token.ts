import { githubUserRequest } from './github';
import type { GitHubRequest } from './contracts';
import type { Env } from './env';
import { ForgeError } from './errors';

/**
 * The one long-lived third-party credential Forge holds, and the only reason it
 * exists: creating a repository.
 *
 * An installation token cannot create a repository on a personal account —
 * `POST /user/repos` is user-authenticated only. Since a repository is created
 * by writing to one that does not exist, and nobody is present to tap anything
 * at that moment, Forge has to be able to act as the user later.
 *
 * So the scope is deliberately narrow. This credential is minted for repository
 * creation and nothing else; every other GitHub call in the product uses the
 * user's own installation token, which they granted per repository and can
 * revoke from GitHub without involving Forge.
 *
 * It is encrypted at rest because D1 is not an appropriate place to keep a
 * bearer credential in plaintext, and revoked by deleting the row.
 */

const CONTEXT = 'forge.usertoken.v1';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** Refresh this far ahead of expiry, so a slow call cannot land after it. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface StoredCredential {
  token: string;
  refreshToken: string | null;
  expiresAt: string | null;
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
export async function storeUserCredential(
  env: Env,
  userId: string,
  credential: { token: string; refreshToken?: string | null; expiresInSeconds?: number | null }
): Promise<void> {
  const expiresAt = credential.expiresInSeconds
    ? new Date(Date.now() + credential.expiresInSeconds * 1000).toISOString()
    : null;

  await env.METADATA.prepare(
    `UPDATE users
        SET github_token = ?2, github_refresh_token = ?3, github_token_expires_at = ?4, updated_at = ?5
      WHERE id = ?1`
  )
    .bind(
      userId,
      await seal(env, credential.token),
      credential.refreshToken ? await seal(env, credential.refreshToken) : null,
      expiresAt,
      new Date().toISOString()
    )
    .run();
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
    expiresAt: row.github_token_expires_at
  };
}

async function refresh(env: Env, userId: string, refreshToken: string): Promise<string | null> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Forge-MCP' },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  }).catch(() => null);

  // GitHub answers 200 with `{ "error": ... }` for a spent refresh token, so
  // the status is not the test — the presence of a token is.
  const body = (await response?.json().catch(() => null)) as Record<string, unknown> | null;
  const token = typeof body?.access_token === 'string' ? body.access_token : null;
  if (!token) return null;

  await storeUserCredential(env, userId, {
    token,
    refreshToken: typeof body?.refresh_token === 'string' ? body.refresh_token : refreshToken,
    expiresInSeconds: typeof body?.expires_in === 'number' ? body.expires_in : null
  });
  return token;
}

/**
 * A GitHub request authenticated as the user. Only repository creation should
 * ever ask for this.
 *
 * Failure names the fix: signing in again is what restores it, and saying so is
 * the difference between a dead end and a next step.
 */
export async function userRequestFor(env: Env, userId: string): Promise<GitHubRequest> {
  const stored = await load(env, userId);
  if (!stored) {
    throw new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message:
        'Forge needs you to sign in with GitHub again before it can create a repository. ' +
        'Reconnect the Forge app, then ask again.',
      retryable: false
    });
  }

  const expired =
    stored.expiresAt !== null && Date.parse(stored.expiresAt) - REFRESH_SKEW_MS <= Date.now();

  if (!expired) return githubUserRequest(env, stored.token);

  const renewed = stored.refreshToken ? await refresh(env, userId, stored.refreshToken) : null;
  if (!renewed) {
    throw new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message:
        'Your GitHub sign-in has expired, so Forge cannot create a repository for you. ' +
        'Reconnect the Forge app, then ask again. Nothing was created.',
      retryable: false
    });
  }
  return githubUserRequest(env, renewed);
}
