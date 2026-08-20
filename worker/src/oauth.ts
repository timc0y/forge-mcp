/**
 * OAuth 2.1 + PKCE for the MCP client, with GitHub as the upstream identity.
 *
 * Forge is the authorization server the client talks to, and GitHub is the only
 * thing that knows who anyone is. So every endpoint here does one of two jobs:
 * hand the browser to GitHub, or turn what GitHub said into a Forge token.
 *
 * There is no refresh token. A refresh token is a second long-lived credential
 * to store, rotate, revoke and get wrong, and it buys a shorter access token —
 * but the access token is already revocable, because `authenticate` re-reads
 * the user row on every request and a deleted user's tokens die immediately.
 * One credential with a real expiry is the smaller of the two designs.
 *
 * There is also no pending-authorization table. The authorize request has to
 * survive a round trip through GitHub, and the only place to put it is the
 * `state` parameter, so `state` is signed with `FORGE_SIGNING_KEY` and carries
 * the request with it. That is a deliberate trade: it means the invite code is
 * visible in the URL Forge sends to GitHub, which is why an invite is single
 * use, claimed atomically, and never written to a log or a page.
 *
 * The invite gate lives in `callback`, not in `authorize`, because `authorize`
 * does not yet know who the user is. Hitting `callback` directly cannot skip
 * it: without a valid signature over the state there is no flow, and without a
 * user row there is no code to redeem.
 */
import type { Env } from './env';
import { isForgeError } from './errors';
import { githubUserRequest } from './github';
import { storeUserCredential } from './user-token';
import { analyticsFor } from './analytics';
import { issueToken } from './identity';

/**
 * Thirty days.
 *
 * The client is often a phone, and re-authorizing means a browser hop, a GitHub
 * login and a return trip — friction a person feels every single time. Anything
 * on the order of an hour would need a refresh token to be usable, which is the
 * credential this design deliberately does not have. Thirty days is long enough
 * that a preview user authorizes roughly monthly, and short enough that a token
 * copied out of a client's storage is not a permanent grant. Revocation does
 * not wait for it: deleting the user row invalidates every token that names it.
 */
const ACCESS_TOKEN_SECONDS = 30 * 24 * 60 * 60;

/** Long enough to redeem immediately, short enough to be worthless if leaked. */
const AUTHORIZATION_CODE_MS = 10 * 60 * 1000;

/**
 * Long enough to log into GitHub on a phone, or to create an account mid-flow.
 * Short enough that a state URL captured from a browser's history is not a
 * standing invitation to replay it.
 */
const STATE_MS = 30 * 60 * 1000;

const STATE_CONTEXT = 'forge.oauth.state.v1';

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  user_id: string;
  expires_at: string;
  used_at: string | null;
}

/** The authorize request, carried through GitHub and back. */
interface FlowState {
  /** Forge's own client id, not GitHub's. */
  client: string;
  redirect: string;
  challenge: string;
  /** The MCP client's `state`, returned untouched. It is their CSRF defence. */
  clientState: string;
  exp: number;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export function protectedResourceMetadata(env: Env): Response {
  return json({
    resource: `${env.FORGE_PUBLIC_ORIGIN}/mcp`,
    authorization_servers: [env.FORGE_PUBLIC_ORIGIN],
    bearer_methods_supported: ['header']
  });
}

/**
 * No `scopes_supported`, and the `scope` parameter is ignored wherever it
 * appears. There is one identity and one set of powers: a token either speaks
 * for a user or it does not. Advertising a scope would invite a client to ask
 * for something this server cannot refuse differently.
 */
export function authorizationServerMetadata(env: Env): Response {
  const origin = env.FORGE_PUBLIC_ORIGIN;
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256']
  });
}

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

/**
 * ChatGPT registers itself rather than being configured, so this endpoint is
 * open by necessity. What keeps it from being an open redirect factory is the
 * host allowlist: an unauthenticated caller can create a client id, but only
 * one that can send its codes to a host the operator already trusts.
 *
 * No client secret is issued. These are public clients; PKCE is what binds a
 * code to the client that asked for it.
 */
export async function registerClient(env: Env, request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return oauthError('invalid_client_metadata', 'The registration body was not a JSON object.', 400);
  }

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    return oauthError('invalid_redirect_uri', 'Between one and ten redirect_uris are required.', 400);
  }
  const redirectUris: string[] = [];
  for (const uri of uris) {
    if (typeof uri !== 'string' || !redirectAllowed(env, uri)) {
      return oauthError('invalid_redirect_uri', 'A redirect_uri is not an allowed destination.', 400);
    }
    redirectUris.push(uri);
  }

  const rawName = typeof body.client_name === 'string' ? body.client_name.trim() : '';
  const clientName = rawName ? rawName.slice(0, 200) : 'MCP client';
  const clientId = `client_${randomSecret()}`;
  const now = new Date().toISOString();

  await env.METADATA.prepare(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?1, ?2, ?3, ?4)'
  )
    .bind(clientId, clientName, JSON.stringify(redirectUris), now)
    .run();

  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.parse(now) / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code']
    },
    201
  );
}

// ---------------------------------------------------------------------------
// Authorize
// ---------------------------------------------------------------------------

/**
 * GET renders the one screen a person sees; POST sends them to GitHub. Both
 * read the request from the query string and re-run the same validation, so a
 * hand-built POST is checked exactly as hard as the GET that preceded it.
 *
 * A rejected request is answered with a page rather than a redirect. Bouncing
 * an error to a `redirect_uri` that just failed validation is how an
 * authorization server becomes someone else's open redirect.
 */
export async function authorize(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id') ?? '';
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  const responseType = url.searchParams.get('response_type') ?? '';
  const challenge = url.searchParams.get('code_challenge') ?? '';
  const challengeMethod = url.searchParams.get('code_challenge_method') ?? '';

  const client = clientId ? await findClient(env, clientId) : null;
  if (!client) {
    return problem(400, 'This client is not registered', 'Register the client with Forge, then start again.');
  }
  if (responseType !== 'code') {
    return problem(400, 'This request is not supported', 'Forge only issues authorization codes.');
  }
  // Exact match against what the client registered, and the host allowlist
  // again — a host removed from the allowlist must stop working immediately,
  // not stay valid for every client registered while it was permitted.
  if (!registeredUris(client).includes(redirectUri) || !redirectAllowed(env, redirectUri)) {
    return problem(400, 'This redirect address is not allowed', 'It does not match one this client registered.');
  }
  // `plain` is refused rather than accepted-and-ignored: RFC 7636 says an
  // absent method means `plain`, so anything other than an explicit S256 is a
  // downgrade, and a downgrade a server tolerates is a downgrade it offers.
  if (challengeMethod !== 'S256' || !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) {
    return problem(
      400,
      'This request is missing PKCE',
      'Forge requires code_challenge_method=S256 and an S256 code challenge.'
    );
  }

  if (request.method !== 'POST') return consentPage(client.client_name);

  const form = await parseBody(request);
  const state: FlowState = {
    client: client.client_id,
    redirect: redirectUri,
    challenge,
    clientState: url.searchParams.get('state') ?? '',
    exp: Date.now() + STATE_MS
  };

  const target = new URL(GITHUB_AUTHORIZE);
  target.searchParams.set('client_id', env.GITHUB_APP_CLIENT_ID);
  target.searchParams.set('redirect_uri', callbackUrl(env));
  target.searchParams.set('state', await sealState(env, state));
  return redirect(target.toString());
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

/**
 * Everything that decides whether a person becomes a user happens here, in one
 * pass, with no way in from outside except a state Forge signed.
 */
export async function callback(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) {
    return problem(400, 'GitHub did not complete the sign-in', 'Nothing was created. Start again from your client.');
  }

  const state = await openState(env, url.searchParams.get('state') ?? '');
  const githubCode = url.searchParams.get('code') ?? '';
  if (!state || !githubCode) {
    return problem(
      400,
      'This sign-in link is not valid',
      'It may have expired, or it may not have come from Forge. Start again from your client.'
    );
  }

  // Re-validated after the round trip, because a state can outlive a change to
  // what a client is allowed to do. The signature proves Forge issued it, not
  // that it is still permitted.
  const client = await findClient(env, state.client);
  if (!client || !registeredUris(client).includes(state.redirect) || !redirectAllowed(env, state.redirect)) {
    return problem(400, 'This client is no longer allowed', 'Register the client again, then start again.');
  }

  const account = await identifyGitHubUser(env, githubCode);
  if (!account) {
    return problem(
      502,
      'GitHub could not confirm who you are',
      'Nothing was created. Try connecting again in a moment.'
    );
  }

  const found = await findOrCreateUser(env, account);
  if (!found) {
    return problem(500, 'Forge could not create your account', 'Nothing was created. Try connecting again.');
  }
  const userId = found.id;
  if (found.created) analyticsFor(env, userId)('user_signed_up');

  // Kept solely so `forge_edit` can create a repository later, when nobody is
  // present to authorize anything. See user-token.ts for why this is the one
  // long-lived credential in the system.
  await storeUserCredential(env, userId, {
    token: account.token,
    refreshToken: account.refreshToken,
    expiresInSeconds: account.expiresInSeconds
  });

  // Written on every sign-in, including as null. A user who uninstalled the App
  // must lose the stale installation id, so the next tool call tells them to
  // install it rather than failing against an installation GitHub has dropped.
  await env.METADATA.prepare('UPDATE users SET installation_id = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(userId, await discoverInstallation(env, account.token), new Date().toISOString())
    .run();

  const code = randomSecret();
  await env.METADATA.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, user_id, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(
      // Only the hash is stored. A dump of this table must not be redeemable.
      await sha256(code),
      state.client,
      state.redirect,
      state.challenge,
      userId,
      new Date(Date.now() + AUTHORIZATION_CODE_MS).toISOString()
    )
    .run();

  const target = new URL(state.redirect);
  target.searchParams.set('code', code);
  if (state.clientState) target.searchParams.set('state', state.clientState);
  return redirect(target.toString());
}

/**
 * Find the user behind this GitHub account, or make one.
 *
 * The preview is open: anyone who can authorize the App becomes a user. What
 * stops "open" from becoming "expensive" is the daily limit in quota.ts, not a
 * gate at the door — a limit degrades for one person on one day, where a gate
 * refuses everybody who did not already know somebody.
 */
async function findOrCreateUser(
  env: Env,
  account: { id: string; login: string }
): Promise<{ id: string; created: boolean } | null> {
  const existing = await env.METADATA.prepare('SELECT id FROM users WHERE github_user_id = ?1')
    .bind(account.id)
    .first<{ id: string }>();

  if (existing) {
    // A GitHub login can be renamed while the numeric id never changes, so the
    // id is the identity and the login is display that needs refreshing.
    await env.METADATA.prepare('UPDATE users SET github_login = ?2, updated_at = ?3 WHERE id = ?1')
      .bind(existing.id, account.login, new Date().toISOString())
      .run();
    return { id: existing.id, created: false };
  }

  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.METADATA.prepare(
    `INSERT INTO users (id, github_user_id, github_login, installation_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?4)`
  )
    .bind(userId, account.id, account.login, now)
    .run();

  return { id: userId, created: true };
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export async function token(env: Env, request: Request): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return oauthError('invalid_request', 'The token request body could not be read.', 400);

  if ((body.get('grant_type') ?? '') !== 'authorization_code') {
    return oauthError(
      'unsupported_grant_type',
      'Forge issues long-lived access tokens and supports the authorization_code grant only.',
      400
    );
  }

  const row = await env.METADATA.prepare(
    `SELECT code_hash, client_id, redirect_uri, code_challenge, user_id, expires_at, used_at
       FROM oauth_codes WHERE code_hash = ?1`
  )
    .bind(await sha256(body.get('code') ?? ''))
    .first<CodeRow>();

  // One refusal for every reason. Which check failed is information about
  // whether a code exists, and this endpoint is unauthenticated.
  if (!row) return invalidGrant();
  if (row.used_at) return invalidGrant();
  if (row.client_id !== (body.get('client_id') ?? '')) return invalidGrant();
  if (row.redirect_uri !== (body.get('redirect_uri') ?? '')) return invalidGrant();
  if (Date.parse(row.expires_at) <= Date.now()) return invalidGrant();
  if (!(await verifyPkce(body.get('code_verifier') ?? '', row.code_challenge))) return invalidGrant();

  // Single use is enforced by the UPDATE, not by the `used_at` read above: two
  // simultaneous redemptions both see a null `used_at`, and only one of them
  // can change a row that still has one. `changes` says which.
  const spent = await env.METADATA.prepare(
    'UPDATE oauth_codes SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL'
  )
    .bind(new Date().toISOString(), row.code_hash)
    .run();
  if ((spent.meta.changes ?? 0) !== 1) return invalidGrant();

  return json({
    access_token: await issueToken(env, row.user_id, ACCESS_TOKEN_SECONDS),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS
  });
}

function invalidGrant(): Response {
  return oauthError('invalid_grant', 'The authorization code is not valid, has expired, or has been used.', 400);
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * The GitHub user token is used for these two calls and then dropped. Nothing
 * stores it: every later request runs on the user's installation token, which
 * `github.ts` mints from the App's own key.
 */
async function identifyGitHubUser(
  env: Env,
  code: string
): Promise<{
  id: string;
  login: string;
  token: string;
  refreshToken: string | null;
  expiresInSeconds: number | null;
} | null> {
  let userToken: string;
  let refreshToken: string | null = null;
  let expiresInSeconds: number | null = null;
  try {
    const response = await fetch(GITHUB_TOKEN, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'Forge-MCP'
      },
      body: JSON.stringify({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl(env)
      })
    });
    // GitHub answers 200 with `{ "error": ... }` for a bad code, so the status
    // is not the test — the presence of a token is.
    const parsed: unknown = await response.json();
    const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const value = body.access_token;
    if (typeof value !== 'string' || !value) return null;
    userToken = value;
    // Present only when the App expires user tokens; absent means the token
    // does not expire and there is nothing to refresh.
    refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : null;
    expiresInSeconds = typeof body.expires_in === 'number' ? body.expires_in : null;
  } catch {
    // Never relayed: an exchange failure can carry the client secret in its body.
    return null;
  }

  const request = await githubUserRequest(env, userToken);
  const response = await request('/user');
  if (response.status !== 200) return null;
  const account = response.json as { id?: number; login?: string } | null;
  if (typeof account?.id !== 'number' || typeof account.login !== 'string') return null;
  return {
    id: String(account.id),
    login: account.login,
    token: userToken,
    refreshToken,
    expiresInSeconds
  };
}

/**
 * Which installation of this App the user has. Asked as the user rather than as
 * the App, because "installations this person can see" is a question only their
 * own token can answer.
 */
async function discoverInstallation(env: Env, userToken: string): Promise<string | null> {
  const request = await githubUserRequest(env, userToken);
  const response = await request('/user/installations?per_page=100');
  if (response.status !== 200) return null;
  const body = response.json as { installations?: Array<{ id?: number; app_id?: number }> } | null;
  const appId = Number.parseInt(env.GITHUB_APP_ID, 10);
  const match = body?.installations?.find((installation) => installation.app_id === appId);
  return typeof match?.id === 'number' ? String(match.id) : null;
}

// ---------------------------------------------------------------------------
// Clients and redirect addresses
// ---------------------------------------------------------------------------

async function findClient(env: Env, clientId: string): Promise<ClientRow | null> {
  return env.METADATA.prepare(
    'SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?1'
  )
    .bind(clientId)
    .first<ClientRow>();
}

function registeredUris(client: ClientRow): string[] {
  try {
    const value: unknown = JSON.parse(client.redirect_uris);
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : [];
  } catch {
    return [];
  }
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];

/**
 * `endsWith('.' + host)` rather than `includes`: `chatgpt.com.evil.example`
 * contains the allowed host and is not it.
 */
function redirectAllowed(env: Env, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = LOOPBACK.includes(hostname);
  // A code delivered over plaintext is a code an observer has. Loopback is the
  // one exception, because it never leaves the machine.
  if (url.protocol !== 'https:' && !loopback) return false;
  if (url.hash) return false;

  return env.FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS.split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function callbackUrl(env: Env): string {
  return `${env.FORGE_PUBLIC_ORIGIN}/oauth/callback`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

async function sealState(env: Env, state: FlowState): Promise<string> {
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(state)));
  return `${payload}.${await signState(env, payload)}`;
}

async function openState(env: Env, value: string): Promise<FlowState | null> {
  const separator = value.indexOf('.');
  if (separator <= 0) return null;
  const payload = value.slice(0, separator);
  // Signature first: the redirect address inside this payload is about to be
  // trusted enough to send a code to, so it must not be read before it is proven.
  if (!constantTimeEqual(value.slice(separator + 1), await signState(env, payload))) return null;

  let record: Record<string, unknown>;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const text = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const exp = record.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= Date.now()) return null;
  if (typeof record.client !== 'string' || typeof record.redirect !== 'string') return null;
  if (typeof record.challenge !== 'string' || typeof record.clientState !== 'string') return null;

  return {
    client: record.client,
    redirect: record.redirect,
    challenge: record.challenge,
    clientState: record.clientState,
    exp
  };
}

function signState(env: Env, payload: string): Promise<string> {
  return hmac(env, `${STATE_CONTEXT}.${payload}`);
}

// ---------------------------------------------------------------------------
// Crypto and encoding
// ---------------------------------------------------------------------------

async function hmac(env: Env, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.FORGE_SIGNING_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))));
}

async function sha256(value: string): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  // A verifier short enough to guess is not a verifier. RFC 7636 sets 43..128.
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return constantTimeEqual(await sha256(verifier), challenge);
}

function randomSecret(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] ?? 0);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** See `identity.ts` — the same reasoning, kept local so neither file owns the other. */
function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function parseBody(request: Request): Promise<URLSearchParams | null> {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const parsed: unknown = await request.json();
      if (typeof parsed !== 'object' || parsed === null) return null;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') params.set(key, value);
      }
      return params;
    }
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * `access-control-allow-origin: *` because browser-based MCP clients fetch
 * these endpoints directly. Nothing here is protected by an origin: metadata is
 * public, and registration and token exchange carry their own proofs. No
 * cookie is ever set, so there is nothing ambient for another origin to spend.
 */
function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}

function oauthError(error: string, description: string, status: number): Response {
  return json({ error, error_description: description }, status);
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      // This URL carries a single-use code. It is never logged and never cached.
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer'
    }
  });
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/** A client name arrives from an unauthenticated registration call. Treat it as hostile. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * No external CSS, script, font or image — partly so the page renders in an
 * in-app browser on a phone, and partly because every subresource is a third
 * party who would learn this URL. `Canvas`/`CanvasText` are the reader's own
 * system colours, which is a whole theme system for free.
 */
const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px 64px;background:Canvas;color:CanvasText;
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:32rem;margin:0 auto}
h1{font-size:1.45rem;line-height:1.25;margin:0 0 .35rem}
.lead{margin:0 0 1.6rem;color:GrayText}
.box{border:1px solid GrayText;border-radius:10px;padding:14px 16px;margin:0 0 1.2rem}
label{display:block;font-weight:600;margin:0 0 .4rem}
label span{font-weight:400;color:GrayText}
input{width:100%;min-height:46px;padding:.7rem;border:1px solid GrayText;border-radius:10px;
background:Canvas;color:CanvasText;font:inherit}
input:focus-visible{outline:2px solid CanvasText;outline-offset:2px}
button{font:inherit;margin-top:1.2rem;padding:.75rem 1.35rem;border-radius:9px;
border:1px solid CanvasText;background:CanvasText;color:Canvas;cursor:pointer}
.note{color:GrayText;font-size:.9rem}
`;

function page(status: number, title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex,nofollow">` +
      `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
      `<body><main>${body}</main></body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // The query string of this page is part of an authorization request.
        // Never cache it, never leak it in a Referer, never let it be framed.
        'cache-control': 'no-store, private',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
        // `form-action` names GitHub as well as self: the consent form posts
        // here and this origin answers with a redirect to GitHub. CSP3 says a
        // redirect after a form post is not re-checked, but browsers have
        // enforced it against the redirect target before, and a fix for that
        // would look like the sign-in silently failing in one browser.
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; " +
          "form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'"
      }
    }
  );
}

function problem(status: number, heading: string, detail: string): Response {
  return page(
    status,
    `Forge — ${heading}`,
    `<h1>${escapeHtml(heading)}</h1><div class="box"><p>${escapeHtml(detail)}</p></div>`
  );
}

/**
 * The form posts to this same URL, so the authorize request stays in the query
 * string and never has to be copied into hidden fields a person could edit.
 */
function consentPage(clientName: string): Response {
  return page(
    200,
    'Connect Forge',
    `<h1>Connect Forge</h1>
<p class="lead">This lets <strong>${escapeHtml(clientName)}</strong> work on GitHub as you — reading repositories, writing to change branches, and asking you to approve anything that lands on <code>main</code>.</p>
<form method="post">
<button type="submit">Continue with GitHub</button>
</form>
<p class="note">Forge is a free research preview. After GitHub asks, you choose which repositories it may reach — and you can change that later without involving Forge.</p>`
  );
}

