/**
 * The only place a GitHub credential is minted, held, or attached to a request.
 *
 * Two credential scopes exist. Everything inside an installed repository runs
 * on the user's own installation token — their rate limit and repository grant.
 * The user-authenticated credential is reserved for the two account/public
 * operations installation scope cannot replace here: creating a personal
 * repository and explicit public GitHub search.
 *
 * Nothing here interprets a response. Status is data: a 404, 409 or 422 is an
 * answer a receipt gets shaped from, and throwing on one would turn every
 * ordinary GitHub refusal into a dead end. The only failures raised are "the
 * network did not answer" and "no token could be minted".
 */
import { SignJWT, importPKCS8 } from 'jose';
import type { GitHubRequest, RepoRef } from './contracts';
import type { Env } from './env';
import { ForgeError, isForgeError } from './errors';

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

async function installationToken(
  env: Env,
  installationId: string,
  forceRefresh = false
): Promise<string> {
  if (forceRefresh) installationTokens.delete(installationId);
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

/**
 * Read a body, stopping the moment it passes `maxBytes` rather than after. The
 * whole point of the bound is that a repository too large to read must cost a
 * cancelled stream, not the memory to hold it first.
 *
 * Returns null when the body is refused for size.
 */
async function readBounded(response: Response, maxBytes?: number): Promise<ArrayBuffer | null> {
  if (!maxBytes || !response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
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
    let text = '';
    let bytes: ArrayBuffer | undefined;
    try {
      // `cache: 'no-store'` is load-bearing, not defensive noise. GitHub sends
      // `Cache-Control: private, max-age=60, s-maxage=60` on reads, and a
      // Workers subrequest can be answered from the edge cache under it: a ref
      // that was deleted and recreated was served at its pre-deletion value,
      // which made an approval refuse itself as "moved". Forge reads GitHub to
      // decide what is true now, so it must never read a cached answer.
      response = await fetch(`${API_BASE}${path}`, {
        method: init?.method ?? 'GET',
        headers,
        body,
        cache: 'no-store'
      });
      if (init?.raw) {
        const read = await readBounded(response, init.maxBytes);
        if (read === null) {
          // Refused, not failed: the caller asked for a bound and this body is
          // past it. 413 keeps that distinct from an unreadable body.
          return { status: 413, json: null, text: '', bytes: undefined, headers: response.headers };
        }
        bytes = read;
      } else {
        text = await response.text();
      }
    } catch (error) {
      if (isForgeError(error)) throw error;
      throw new ForgeError({
        code: 'FORGE_UPSTREAM_UNAVAILABLE',
        message: `GitHub could not be reached (${init?.method ?? 'GET'} ${path}).`,
        retryable: true
      });
    }
    return { status: response.status, json: parseJson(text), text, bytes, headers: response.headers };
  };
}

type InstallationTokenProvider = (
  env: Env,
  installationId: string,
  forceRefresh?: boolean
) => Promise<string>;

/**
 * Repository requests outlive individual installation tokens: MCP sessions can
 * remain connected for hours while GitHub installation tokens expire after one.
 * Resolve the cached token for every request and retry one 401 after forcing a
 * fresh token. Other statuses are real GitHub answers and are never retried.
 *
 * The provider parameter exists only to make expiry/retry behavior testable
 * without a real private key or GitHub call.
 */
export async function githubRequest(
  env: Env,
  installationId: string,
  tokenProvider: InstallationTokenProvider = installationToken
): Promise<GitHubRequest> {
  // Connection setup is where a transient GitHub blip would otherwise empty the
  // whole tool catalog, because a session that cannot mint registers no tools.
  // A failure GitHub itself calls retryable is therefore tried once more; a
  // refusal (no such installation, bad credentials) is not.
  try {
    await tokenProvider(env, installationId, false);
  } catch (error) {
    if (!isForgeError(error) || !error.retryable) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await tokenProvider(env, installationId, false);
  }

  return async (path, init) => {
    const first = await requester(await tokenProvider(env, installationId, false))(path, init);
    if (first.status !== 401) return first;
    return requester(await tokenProvider(env, installationId, true))(path, init);
  };
}

/**
 * The installation this App currently has for an account.
 *
 * A stored installation id is a snapshot. GitHub never tells Forge when someone
 * uninstalls and installs the App again, so the row can name an installation
 * that no longer exists, every token mint is a 404, and the session has nothing
 * to work with. The App's own installation list is the one answer that is
 * current by construction.
 *
 * Returns null when the App is not installed for that login, or when GitHub
 * cannot be asked — the caller treats both as "no installation to heal from".
 */
export async function installationForLogin(env: Env, login: string): Promise<string | null> {
  let jwt: string;
  try {
    jwt = await appJwt(env);
  } catch {
    return null;
  }
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
    authorization: `Bearer ${jwt}`
  };

  // Ask the exact question first. "The installation this account has" is one
  // GitHub answers directly, so nothing has to be searched through or capped —
  // which is what a list-based lookup gets wrong the moment it outgrows a page.
  for (const owner of ['users', 'orgs'] as const) {
    let exact: Response | null = null;
    try {
      exact = await fetch(`${API_BASE}/${owner}/${encodeURIComponent(login)}/installation`, { headers });
    } catch {
      exact = null;
    }
    if (!exact?.ok) continue;
    const body = parseJson(await exact.text());
    if (isRecord(body) && typeof body.id === 'number') return String(body.id);
  }

  // Fall back to the App's own list for anything the exact lookups do not name.
  let listed: Response | null = null;
  try {
    listed = await fetch(`${API_BASE}/app/installations?per_page=100`, { headers });
  } catch {
    return null;
  }
  if (!listed?.ok) return null;

  const installations = parseJson(await listed.text());
  if (!Array.isArray(installations)) return null;

  const wanted = login.toLowerCase();
  const match = installations.find(
    (entry) =>
      isRecord(entry) &&
      isRecord(entry.account) &&
      typeof entry.account.login === 'string' &&
      entry.account.login.toLowerCase() === wanted
  );
  return isRecord(match) && typeof match.id === 'number' ? String(match.id) : null;
}

/**
 * Repository access for one account, repairing a stored installation id that
 * GitHub has since replaced.
 *
 * A missing installation surfaces as FORGE_AUTH_REQUIRED on the first mint. Any
 * other failure — a 5xx, a network error — is a real upstream problem and is
 * thrown as-is rather than mistaken for a reinstall. When the account does have
 * a current installation, it is remembered and the mint is retried once.
 */
export async function installationRequestFor(
  env: Env,
  storedInstallationId: string,
  login: string,
  remember: (installationId: string) => Promise<void>,
  tokenProvider?: InstallationTokenProvider
): Promise<GitHubRequest> {
  try {
    return await githubRequest(env, storedInstallationId, tokenProvider);
  } catch (error) {
    if (!isForgeError(error) || error.code !== 'FORGE_AUTH_REQUIRED') throw error;

    const live = await installationForLogin(env, login);
    if (!live || live === storedInstallationId) throw error;

    await remember(live);
    return githubRequest(env, live, tokenProvider);
  }
}

/**
 * Authenticated as the human. Repository creation and explicit public GitHub
 * search need this; ordinary reads/writes always use the installation token.
 * Never cached here: the stored/rotating credential lifecycle lives in
 * user-token.ts.
 */
export async function githubUserRequest(_env: Env, userAccessToken: string): Promise<GitHubRequest> {
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
