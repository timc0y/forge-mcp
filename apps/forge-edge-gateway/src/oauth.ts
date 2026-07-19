import { SignJWT, jwtVerify } from 'jose';
import type { Env } from './env';
import { getWebSession, type UserRow } from './github';

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
  return new TextEncoder().encode(env.FORGE_CAPABILITY_SIGNING_KEY);
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

function redirectUriAllowed(value: string, env: Env): boolean {
  try {
    const url = new URL(value);
    const allowed = (env.FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS ?? 'chatgpt.com,openai.com,claude.ai,anthropic.com,localhost,127.0.0.1')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1') return false;
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

// The set of origins Forge itself owns and serves: the public gateway origin
// (approval and preview URLs live under it — /approvals/:id, /preview/…) and the
// dedicated preview host used for exposed workspace previews. Only these qualify
// as "allowed link URIs" a host may open from the widget without a per-link
// confirmation; third-party targets (e.g. github.com PR links) intentionally do
// not appear and will still prompt. Exported so the surface that actually
// advertises owned origins to the host can reuse this derivation without
// duplicating it. See docs/connectors.md — as of @modelcontextprotocol/ext-apps
// 1.7.2 there is no allowed-link-URIs field on the MCP Apps resource `_meta.ui`
// (only csp/permissions/domain/prefersBorder) or on the OAuth metadata, so this
// cannot yet be emitted here; it is kept as a single source of truth for when a
// host or spec field exists.
export function forgeOwnedOrigins(env: Env): string[] {
  const origins = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    try {
      origins.add(new URL(value.includes('://') ? value : `https://${value}`).origin);
    } catch {
      /* ignore an unparseable configured origin */
    }
  };
  add(env.FORGE_PUBLIC_ORIGIN);
  add(env.FORGE_PREVIEW_HOSTNAME);
  return [...origins];
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
  return html(`<!doctype html>
<meta charset="utf-8">
<title>Authorize Forge MCP</title>
<style>:root{--bg:#f2f4f1;--surface:#fff;--ink:#151a16;--muted:#5c665f;--line:#cfd5d0;--accent:#23784b}*{box-sizing:border-box}body{width:min(100% - 2.5rem,32rem);margin:0 auto;padding:clamp(3rem,10vw,6rem) 0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}h1{margin:0 0 .75rem;font-size:clamp(2.2rem,8vw,3.25rem);line-height:1;letter-spacing:-.035em}p{color:var(--muted);text-wrap:pretty}form{margin-top:2rem;padding:clamp(1.25rem,4vw,2rem);background:var(--surface);border:1px solid var(--line);border-radius:12px}label{display:block;margin:0 0 1rem;font-weight:700}input{width:100%;min-height:46px;margin-top:.45rem;padding:.7rem;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);font:inherit}button{min-height:46px;padding:.7rem 1rem;background:var(--ink);color:#fff;border:0;border-radius:6px;font:inherit;font-weight:700;cursor:pointer}button:hover{background:var(--accent)}input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}[role=alert]{padding:.75rem 1rem;background:#fce3df;color:#731f12;border-radius:6px}</style>
<h1>Authorize Forge MCP</h1>
<p>This connects the MCP client to ${user ? `<strong>${escapeHtml(user.github_login)}</strong>&#39;s` : 'your'} Forge workspace.</p>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post">${fields}${user ? '' : '<label>Forge development token<input name="token" type="password" autocomplete="current-password" required></label>'}<button>Authorize</button></form>`);
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
      const { payload } = await jwtVerify(body.get('refresh_token') ?? '', signingKey(env), {
        issuer: env.FORGE_PUBLIC_ORIGIN,
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
