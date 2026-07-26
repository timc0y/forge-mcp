import { SignJWT, jwtVerify } from 'jose';
import type { Env } from './env';
import { getWebSession, hasForgeAccess, type UserRow } from './github';
import { acceptedIssuers } from './auth';
import { page } from './ui';

const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 60 * 60 * 24 * 30;
const AUTHORIZATION_CODE_SECONDS = 10 * 60;

interface OAuthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
}

interface OAuthCodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  subject: string;
  tenant_id: string;
  project_id: string;
  expires_at: string;
  used_at: string | null;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' }
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    }
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character);
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${base64Url(bytes)}`;
}

async function hash(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function constantTimeEqual(leftValue: string, rightValue: string): boolean {
  const left = new TextEncoder().encode(leftValue);
  const right = new TextEncoder().encode(rightValue);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function signingKey(env: Env): Uint8Array {
  // OAuth session (access/refresh) JWTs are signed with a secret distinct from
  // the capability signing key, so a leak of one cannot forge the other. Falls
  // back to the capability key until the operator sets FORGE_SESSION_SIGNING_KEY.
  return new TextEncoder().encode(env.FORGE_SESSION_SIGNING_KEY ?? env.FORGE_CAPABILITY_SIGNING_KEY);
}

function redirectUris(row: OAuthClientRow): string[] {
  try {
    const value = JSON.parse(row.redirect_uris) as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? value
      : [];
  } catch {
    return [];
  }
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

export function redirectUriAllowed(value: string, env: Env): boolean {
  try {
    const url = new URL(value);
    // Loopback / localhost redirect URIs are a DCR abuse vector, so they are
    // permitted only outside production. In production they are rejected
    // outright and stripped from the allowlist even if explicitly configured.
    const isProduction = env.FORGE_ENVIRONMENT === 'production';
    const defaultHosts = isProduction
      ? 'chatgpt.com,openai.com,claude.ai,anthropic.com'
      : 'chatgpt.com,openai.com,claude.ai,anthropic.com,localhost,127.0.0.1';
    const allowed = (env.FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS ?? defaultHosts)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .filter((host) => !isProduction || !LOOPBACK_HOSTS.includes(host));
    const hostname = url.hostname.toLowerCase();
    const isLoopback = LOOPBACK_HOSTS.includes(hostname);
    if (isProduction && isLoopback) return false;
    // http is tolerated only for non-production loopback callbacks; everything
    // else must be https.
    if (url.protocol !== 'https:' && !(isLoopback && !isProduction)) return false;
    return allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

async function findClient(env: Env, clientId: string): Promise<OAuthClientRow | null> {
  return env.METADATA
    .prepare('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?1')
    .bind(clientId)
    .first<OAuthClientRow>();
}

async function parseBody(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await request.json() as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') params.set(key, value);
    }
    return params;
  }
  return new URLSearchParams(await request.text());
}

async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return constantTimeEqual(base64Url(digest), challenge);
}

async function issueAccessToken(
  env: Env,
  subject: string,
  tenantId: string,
  projectId: string,
  clientId: string,
  scope: string
): Promise<string> {
  return new SignJWT({
    token_type: 'access',
    tenant_id: tenantId,
    project_id: projectId,
    client_id: clientId,
    scope
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(env.FORGE_PUBLIC_ORIGIN)
    .setAudience('forge-mcp')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_SECONDS}s`)
    .sign(signingKey(env));
}

async function issueRefreshToken(
  env: Env,
  subject: string,
  tenantId: string,
  projectId: string,
  clientId: string,
  scope: string
): Promise<string> {
  return new SignJWT({
    token_type: 'refresh',
    tenant_id: tenantId,
    project_id: projectId,
    client_id: clientId,
    scope
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(env.FORGE_PUBLIC_ORIGIN)
    .setAudience('forge-mcp')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_TOKEN_SECONDS}s`)
    .sign(signingKey(env));
}

function tokenResponse(accessToken: string, refreshToken: string): Response {
  return json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refreshToken,
    scope: 'forge:workspace offline_access'
  });
}


export function authorizationServerMetadata(env: Env): Record<string, unknown> {
  const origin = env.FORGE_PUBLIC_ORIGIN;
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['forge:workspace', 'offline_access']
  };
}

export async function registerClient(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_client_metadata' }, 400);
  }

  const uris = body.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > 20 ||
    !uris.every((uri) => typeof uri === 'string' && redirectUriAllowed(uri, env))
  ) {
    return json({ error: 'invalid_redirect_uris' }, 400);
  }
  const clientId = randomToken('client');
  await env.METADATA.prepare(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?1, ?2, ?3, ?4)'
  ).bind(
    clientId,
    typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 200) : 'MCP client',
    JSON.stringify(uris),
    new Date().toISOString()
  ).run();

  return json({
    client_id: clientId,
    client_name: typeof body.client_name === 'string' ? body.client_name : 'MCP client',
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  }, 201);
}

function authorizeForm(url: URL, user?: UserRow, error?: string): Response {
  const fields = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method']
    .map((key) => `<input type="hidden" name="${key}" value="${escapeHtml(url.searchParams.get(key) ?? '')}">`)
    .join('');
  return page({
    title: 'Authorize Forge',
    // The connect screen is the first authenticated surface most people see, so
    // it has to look like the same product as the site they arrived from.
    css: `.centre{max-width:32rem;margin:clamp(2.5rem,8vw,5rem) auto}
label{display:block;margin:0 0 1rem;font-weight:600;color:var(--ink)}
input{width:100%;min-height:46px;margin-top:.45rem;padding:.7rem;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font:inherit}
input:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
[role=alert]{padding:.75rem 1rem;background:var(--bad-bg);color:var(--bad);border-radius:10px;margin-bottom:1rem}`,
    body: `<div class="centre"><h1>Authorize Forge</h1>
<p>This connects your AI client to ${user ? `<strong>${escapeHtml(user.github_login)}</strong>&#39;s` : 'your'} Forge workspace, so it can screenshot sites and work on repositories you have connected.</p>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
<section class="section"><form method="post">${fields}${user ? '' : '<label>Forge development token<input name="token" type="password" autocomplete="current-password" required></label>'}<button class="primary" type="submit">Authorize</button></form></section></div>`
  });
}

export async function authorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id') ?? '';
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  const responseType = url.searchParams.get('response_type') ?? '';
  const challenge = url.searchParams.get('code_challenge') ?? '';
  const challengeMethod = url.searchParams.get('code_challenge_method') ?? '';
  const client = await findClient(env, clientId);
  if (
    !client ||
    responseType !== 'code' ||
    !redirectUris(client).includes(redirectUri) ||
    !challenge ||
    challengeMethod !== 'S256'
  ) {
    return json({ error: 'invalid_request' }, 400);
  }
  const githubEnabled = Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET);
  const user = githubEnabled ? await getWebSession(request, env) : null;
  const ownerToken = env.FORGE_OWNER_AUTH_TOKEN ?? env.FORGE_DEV_AUTH_TOKEN;
  const body = request.method === 'POST' ? await parseBody(request) : null;
  const ownerAuthorized = Boolean(ownerToken && body && constantTimeEqual(body.get('token') ?? '', ownerToken));
  if (githubEnabled && !user && !ownerAuthorized) {
    return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=${encodeURIComponent(request.url)}`, 302);
  }
  // The gate that actually matters: without this an account awaiting approval
  // could still authorize an MCP client and use Forge in full, making the
  // approval decorative. The owner token path is unaffected.
  if (user && !ownerAuthorized && !hasForgeAccess(user)) {
    return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/app`, 302);
  }
  if (!githubEnabled && !ownerToken) return json({ error: 'server_auth_not_configured' }, 503);
  if (request.method === 'GET') return authorizeForm(url, user ?? undefined);

  if (!body) return json({ error: 'invalid_request' }, 400);
  if (!user && !ownerAuthorized) {
    return authorizeForm(url, undefined, 'The Forge token was not accepted.');
  }

  const code = randomToken('code');
  const scope = body.get('scope')?.trim() || url.searchParams.get('scope')?.trim() || 'forge:workspace';
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_SECONDS * 1000).toISOString();
  await env.METADATA.prepare(
    `INSERT INTO oauth_codes
      (code_hash, client_id, redirect_uri, code_challenge, scope, subject, tenant_id, project_id, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(
    await hash(code),
    clientId,
    redirectUri,
    challenge,
    scope,
    user ? `github:${user.github_user_id}` : 'owner-user',
    user?.tenant_id ?? env.FORGE_DEFAULT_TENANT_ID,
    user?.project_id ?? env.FORGE_DEFAULT_PROJECT_ID,
    expiresAt
  ).run();

  const redirect = new URL(redirectUri);
  redirect.searchParams.set('code', code);
  const state = url.searchParams.get('state');
  if (state) redirect.searchParams.set('state', state);
  return Response.redirect(redirect.toString(), 302);
}

export async function token(request: Request, env: Env): Promise<Response> {
  const body = await parseBody(request);
  const grantType = body.get('grant_type') ?? '';
  if (grantType === 'refresh_token') {
    try {
      // Accepts a refresh token issued under a previous origin too, so a
      // domain move does not force every client to re-authorize; the token it
      // is exchanged for is minted under the current canonical origin.
      const { payload } = await jwtVerify(body.get('refresh_token') ?? '', signingKey(env), {
        issuer: acceptedIssuers(env),
        audience: 'forge-mcp'
      });
      if (
        payload.token_type !== 'refresh' ||
        typeof payload.sub !== 'string' ||
        typeof payload.tenant_id !== 'string' ||
        typeof payload.project_id !== 'string' ||
        typeof payload.client_id !== 'string' ||
        typeof payload.scope !== 'string'
      ) return json({ error: 'invalid_grant' }, 400);
      const access = await issueAccessToken(env, payload.sub, payload.tenant_id, payload.project_id, payload.client_id, payload.scope);
      const refresh = await issueRefreshToken(env, payload.sub, payload.tenant_id, payload.project_id, payload.client_id, payload.scope);
      return tokenResponse(access, refresh);
    } catch {
      return json({ error: 'invalid_grant' }, 400);
    }
  }

  if (grantType !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400);
  const code = body.get('code') ?? '';
  const clientId = body.get('client_id') ?? '';
  const redirectUri = body.get('redirect_uri') ?? '';
  const codeVerifier = body.get('code_verifier') ?? '';
  const row = await env.METADATA.prepare(
    'SELECT code_hash, client_id, redirect_uri, code_challenge, scope, subject, tenant_id, project_id, expires_at, used_at FROM oauth_codes WHERE code_hash = ?1'
  ).bind(await hash(code)).first<OAuthCodeRow>();
  if (
    !row ||
    row.used_at ||
    row.client_id !== clientId ||
    row.redirect_uri !== redirectUri ||
    Date.parse(row.expires_at) <= Date.now() ||
    !(await verifyPkce(codeVerifier, row.code_challenge))
  ) return json({ error: 'invalid_grant' }, 400);

  await env.METADATA.prepare('UPDATE oauth_codes SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL')
    .bind(new Date().toISOString(), row.code_hash)
    .run();
  const access = await issueAccessToken(env, row.subject, row.tenant_id, row.project_id, row.client_id, row.scope);
  const refresh = await issueRefreshToken(env, row.subject, row.tenant_id, row.project_id, row.client_id, row.scope);
  return tokenResponse(access, refresh);
}
