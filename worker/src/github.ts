/**
 * The only place a GitHub credential is minted, held, or attached to a request.
 *
 * Two callers exist and they authenticate differently: everything that touches
 * a repository runs on the user's own installation token — their rate limit,
 * their grant — while creating a repository on a personal account is something
 * an installation token cannot do at all, so that one path runs as the user.
 *
 * Nothing here interprets a response. Status is data: a 404, 409 or 422 is an
 * answer a receipt gets shaped from, and throwing on one would turn every
 * ordinary GitHub refusal into a dead end. The only failures raised are "the
 * network did not answer" and "no token could be minted".
 */
import { SignJWT, importPKCS8 } from 'jose';
import type { GitHubRequest, RepoRef } from './contracts';
import type { Env } from './env';
import { ForgeError } from './errors';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const USER_AGENT = 'Forge-MCP';

/** Stop trusting an installation token a minute before GitHub stops honouring it. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Keyed by installation id, which is what makes this safe to hold in module
 * scope: a token can only be handed back to a caller that already named the
 * installation it belongs to. An isolate serves the same user's turns over and
 * over, and minting per call spends two extra round trips every time.
 */
const installationTokens = new Map<string, { token: string; expiresAt: number }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A raw diff is not JSON and is not an error; it is the body the caller asked for. */
function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function appJwt(env: Env): Promise<string> {
  const key = await importPKCS8(env.GITHUB_APP_PRIVATE_KEY, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  // GitHub rejects a JWT issued in its own future and caps the lifetime at ten
  // minutes. Our clock is not their clock, so back-date and stay well inside.
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.GITHUB_APP_ID)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(key);
}

async function installationToken(env: Env, installationId: string): Promise<string> {
  const cached = installationTokens.get(installationId);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;

  let response: Response;
  let body: string;
  try {
    const jwt = await appJwt(env);
    response = await fetch(
      `${API_BASE}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': USER_AGENT,
          'x-github-api-version': API_VERSION,
          authorization: `Bearer ${jwt}`
        }
      }
    );
    body = await response.text();
  } catch {
    // The thrown cause is never relayed: a signing failure can carry key material.
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: 'GitHub could not be reached to authorize this request. Try again shortly.',
      retryable: true
    });
  }

  if (!response.ok) {
    const missing = response.status === 401 || response.status === 404;
    throw new ForgeError({
      code: missing ? 'FORGE_AUTH_REQUIRED' : 'FORGE_UPSTREAM_UNAVAILABLE',
      message: missing
        ? 'The Forge GitHub App is not installed for this account. Install it, then try again.'
        : `GitHub declined to issue an installation token (HTTP ${response.status}).`,
      retryable: response.status >= 500
    });
  }

  const result = parseJson(body);
  const token = isRecord(result) && typeof result.token === 'string' ? result.token : null;
  if (!token) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: 'GitHub returned no installation token.',
      retryable: true
    });
  }
  // No expiry, no cache. Guessing a lifetime is how a stale token gets reused.
  const expiresAt = isRecord(result) && typeof result.expires_at === 'string' ? Date.parse(result.expires_at) : NaN;
  if (Number.isFinite(expiresAt)) installationTokens.set(installationId, { token, expiresAt });
  return token;
}

function requester(token: string): GitHubRequest {
  return async (path, init) => {
    const headers = new Headers({
      accept: init?.accept ?? 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': API_VERSION,
      authorization: `Bearer ${token}`
    });
    const body = init?.body === undefined ? undefined : JSON.stringify(init.body);
    if (body !== undefined) headers.set('content-type', 'application/json');

    let response: Response;
    let text: string;
    try {
      response = await fetch(`${API_BASE}${path}`, { method: init?.method ?? 'GET', headers, body });
      text = await response.text();
    } catch {
      throw new ForgeError({
        code: 'FORGE_UPSTREAM_UNAVAILABLE',
        message: `GitHub could not be reached (${init?.method ?? 'GET'} ${path}).`,
        retryable: true
      });
    }
    return { status: response.status, json: parseJson(text), text, headers: response.headers };
  };
}

export async function githubRequest(env: Env, installationId: string): Promise<GitHubRequest> {
  return requester(await installationToken(env, installationId));
}

/**
 * Authenticated as the human. Only creating a repository needs this, because an
 * installation cannot create one on the account that installed it. Never
 * cached: the token belongs to a session, not to this isolate.
 */
export async function githubUserRequest(env: Env, userAccessToken: string): Promise<GitHubRequest> {
  return requester(userAccessToken);
}

// GitHub's own limits: an owner is up to 39 alphanumerics and inner hyphens; a
// repository name is up to 100 of alphanumeric, dot, dash and underscore.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function parseRepo(value: string): RepoRef {
  const parts = value.trim().split('/').map((part) => part.trim());
  // An absent half becomes '', which fails the pattern rather than being guessed at.
  const owner = parts[0] ?? '';
  const name = parts[1] ?? '';
  // `.` and `..` match the name pattern but are paths, not repositories.
  if (parts.length !== 2 || !OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `"${value.trim()}" is not a repository. Give it as owner/name, for example octocat/hello-world.`,
      details: { value }
    });
  }
  return { owner, name };
}
