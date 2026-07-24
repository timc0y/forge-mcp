import { SignJWT, importPKCS8 } from 'jose';
import { ForgeError, ids, type RepositoryRef, type Workspace } from '@forge/core';
import { issueCapability, verifyCapability } from '@forge/capabilities';
import { assertReceivePackScope, parseReceivePackCommands } from '@forge/git-core';
import type { AuthenticatedContext } from './auth';
import type { Env } from './env';
import { listSlotOccupants, slotTtlMs, workspaceCaps } from './capacity';

const GITHUB_API_VERSION = '2026-03-10';
const SESSION_SECONDS = 60 * 60 * 24 * 14;
const LOGIN_STATE_SECONDS = 10 * 60;

interface GitHubUser {
  id: number;
  login: string;
  avatar_url?: string;
}

export interface UserRow {
  id: string;
  github_user_id: string;
  github_login: string;
  avatar_url: string | null;
  tenant_id: string;
  project_id: string;
}

interface RepositoryRow {
  installation_id: string;
  tenant_id: string;
  project_id: string;
  owner: string;
  name: string;
  authorization_state: string;
  visibility: string;
  default_branch: string;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new ForgeError({
    code: 'FORGE_INTERNAL_ERROR',
    message: `Forge GitHub App is not configured: ${name}.`,
    retryable: false
  });
  return value.trim();
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function randomToken(prefix: string): string {
  return `${prefix}_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

async function hash(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function id(prefix: string, value: string): Promise<string> {
  return hash(value).then((digest) => `${prefix}_${digest.slice(0, 26)}`);
}

function cookie(request: Request, name: string): string {
  const source = request.headers.get('cookie') ?? '';
  for (const part of source.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function sessionCookie(token: string, maxAge = SESSION_SECONDS): string {
  return `forge_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
}

function assertSameOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== env.FORGE_PUBLIC_ORIGIN) throw new ForgeError({
    code: 'FORGE_PERMISSION_DENIED', message: 'Cross-origin form submission was rejected.', retryable: false
  });
}

function base64UrlDecode(value: string): ArrayBuffer {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

// Signed approval links let a reviewer open — and approve — the exact action
// straight from the agent transcript without a fresh GitHub login. The token
// binds ONE approval id + tenant + expiry under the capability signing key; it
// authorises reading and resolving that single approval only, never a general
// web session. Whoever created the approval already proved tenant ownership, so
// the link simply carries that proof forward to the human who clicks it.
interface ApprovalLinkClaims {
  aid: string;
  tenant: string;
  exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signApprovalLink(env: Env, approvalId: string, tenantId: string, expiresAtIso: string): Promise<string> {
  const claims: ApprovalLinkClaims = { aid: approvalId, tenant: tenantId, exp: Date.parse(expiresAtIso) };
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(env.FORGE_CAPABILITY_SIGNING_KEY), new TextEncoder().encode(payload));
  return `${payload}.${base64Url(signature)}`;
}

async function verifyApprovalLink(env: Env, token: string, approvalId: string): Promise<ApprovalLinkClaims | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  let signatureBytes: ArrayBuffer;
  try {
    signatureBytes = base64UrlDecode(token.slice(dot + 1));
  } catch { return null; }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.FORGE_CAPABILITY_SIGNING_KEY), signatureBytes, new TextEncoder().encode(payload));
  if (!ok) return null;
  let claims: ApprovalLinkClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as ApprovalLinkClaims;
  } catch { return null; }
  if (claims.aid !== approvalId || typeof claims.tenant !== 'string' || typeof claims.exp !== 'number' || claims.exp <= Date.now()) return null;
  return claims;
}

function githubHeaders(token?: string): Headers {
  const headers = new Headers({
    accept: 'application/vnd.github+json',
    'user-agent': 'Forge-MCP',
    'x-github-api-version': GITHUB_API_VERSION
  });
  if (token) headers.set('authorization', `Bearer ${token}`);
  return headers;
}

async function githubJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    console.error('forge_github_api_error', { status: response.status, url: new URL(url).pathname });
    throw new ForgeError({
      code: response.status === 404 ? 'FORGE_PERMISSION_DENIED' : 'FORGE_PROVIDER_UNAVAILABLE',
      message: 'GitHub could not complete the requested operation.',
      retryable: response.status >= 500
    });
  }
  return JSON.parse(body) as T;
}

async function appJwt(env: Env): Promise<string> {
  const key = await importPKCS8(required(env.GITHUB_APP_PRIVATE_KEY, 'GITHUB_APP_PRIVATE_KEY'), 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(required(env.GITHUB_APP_ID, 'GITHUB_APP_ID'))
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 540)
    .sign(key);
}

async function installationToken(
  env: Env,
  installationId: string,
  repository: string,
  permission: 'read' | 'write'
): Promise<string> {
  const result = await githubJson<{ token: string }>(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: githubHeaders(await appJwt(env)),
      body: JSON.stringify({ repositories: [repository], permissions: { contents: permission, pull_requests: permission } })
    }
  );
  return result.token;
}

export async function getWebSession(request: Request, env: Env): Promise<UserRow | null> {
  const token = cookie(request, 'forge_session');
  if (!token) return null;
  return env.METADATA.prepare(
    `SELECT u.id, u.github_user_id, u.github_login, u.avatar_url, u.tenant_id, u.project_id
       FROM web_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2`
  ).bind(await hash(token), new Date().toISOString()).first<UserRow>();
}

export async function startGitHubLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestedReturn = url.searchParams.get('return_to') ?? '/app';
  const candidate = new URL(requestedReturn, env.FORGE_PUBLIC_ORIGIN);
  const returnUrl = candidate.origin === env.FORGE_PUBLIC_ORIGIN
    ? candidate
    : new URL('/app', env.FORGE_PUBLIC_ORIGIN);
  const state = randomToken('ghstate');
  await env.METADATA.prepare(
    'INSERT INTO github_login_states (state_hash, return_to, expires_at) VALUES (?1, ?2, ?3)'
  ).bind(
    await hash(state),
    returnUrl.toString(),
    new Date(Date.now() + LOGIN_STATE_SECONDS * 1000).toISOString()
  ).run();
  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', required(env.GITHUB_APP_CLIENT_ID, 'GITHUB_APP_CLIENT_ID'));
  authorizeUrl.searchParams.set('redirect_uri', `${env.FORGE_PUBLIC_ORIGIN}/login/github/callback`);
  authorizeUrl.searchParams.set('state', state);
  return Response.redirect(authorizeUrl.toString(), 302);
}

export async function finishGitHubLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const stateHash = await hash(state);
  const row = await env.METADATA.prepare(
    'SELECT return_to, expires_at, used_at FROM github_login_states WHERE state_hash = ?1'
  ).bind(stateHash).first<{ return_to: string; expires_at: string; used_at: string | null }>();
  if (!code || !row || row.used_at || Date.parse(row.expires_at) <= Date.now()) {
    throw new ForgeError({ code: 'FORGE_AUTH_REQUIRED', message: 'GitHub login expired or was invalid.', retryable: false });
  }
  await env.METADATA.prepare('UPDATE github_login_states SET used_at = ?1 WHERE state_hash = ?2 AND used_at IS NULL')
    .bind(new Date().toISOString(), stateHash).run();

  const token = await githubJson<{ access_token: string }>('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: new Headers({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Forge-MCP'
    }),
    body: new URLSearchParams({
      client_id: required(env.GITHUB_APP_CLIENT_ID, 'GITHUB_APP_CLIENT_ID'),
      client_secret: required(env.GITHUB_APP_CLIENT_SECRET, 'GITHUB_APP_CLIENT_SECRET'),
      code,
      redirect_uri: `${env.FORGE_PUBLIC_ORIGIN}/login/github/callback`
    }).toString()
  });
  if (!token.access_token) throw new ForgeError({ code: 'FORGE_AUTH_REQUIRED', message: 'GitHub did not issue a user authorization token.', retryable: false });
  const user = await githubJson<GitHubUser>('https://api.github.com/user', { headers: githubHeaders(token.access_token) });
  const userId = await id('usr', String(user.id));
  const tenantId = await id('ten', `github:${user.id}`);
  const projectId = await id('prj', `github:${user.id}:default`);
  const now = new Date().toISOString();
  await env.METADATA.batch([
    env.METADATA.prepare('INSERT OR IGNORE INTO tenants (id, name, status, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(tenantId, `${user.login} Forge`, 'active', now),
    env.METADATA.prepare('INSERT OR IGNORE INTO projects (id, tenant_id, name, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(projectId, tenantId, 'GitHub repositories', now),
    env.METADATA.prepare(
      `INSERT INTO users (id, github_user_id, github_login, avatar_url, tenant_id, project_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(github_user_id) DO UPDATE SET github_login=excluded.github_login, avatar_url=excluded.avatar_url, updated_at=excluded.updated_at`
    ).bind(userId, String(user.id), user.login, user.avatar_url ?? null, tenantId, projectId, now)
  ]);
  const session = randomToken('session');
  await env.METADATA.prepare('INSERT INTO web_sessions (token_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await hash(session), userId, new Date(Date.now() + SESSION_SECONDS * 1000).toISOString(), now).run();
  return new Response(null, { status: 302, headers: { location: row.return_to, 'set-cookie': sessionCookie(session), 'cache-control': 'no-store' } });
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const token = cookie(request, 'forge_session');
  if (token) await env.METADATA.prepare('DELETE FROM web_sessions WHERE token_hash = ?1').bind(await hash(token)).run();
  return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': sessionCookie('', 0) } });
}

export async function installGitHubApp(request: Request, env: Env): Promise<Response> {
  const user = await getWebSession(request, env);
  if (!user) return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github`, 302);
  const state = randomToken('ghinstall');
  await env.METADATA.prepare('INSERT INTO github_install_states (state_hash, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await hash(state), user.id, new Date(Date.now() + LOGIN_STATE_SECONDS * 1000).toISOString()).run();
  const installUrl = new URL(`https://github.com/apps/${encodeURIComponent(required(env.GITHUB_APP_SLUG, 'GITHUB_APP_SLUG'))}/installations/new`);
  installUrl.searchParams.set('state', state);
  return Response.redirect(installUrl.toString(), 302);
}

async function syncInstallation(env: Env, user: UserRow, installationId: string): Promise<number> {
  const jwt = await appJwt(env);
  const installation = await githubJson<{
    id: number;
    account: { id: number; login: string; type: string };
    permissions: Record<string, string>;
  }>(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}`, { headers: githubHeaders(jwt) });
  const result = await githubJson<{ token: string }>(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    { method: 'POST', headers: githubHeaders(jwt), body: JSON.stringify({ permissions: { contents: 'read' } }) }
  );
  const token = result.token;
  const repositories = await githubJson<{ repositories: Array<{
    id: number; name: string; full_name: string; private: boolean; default_branch: string;
    owner: { login: string };
  }> }>('https://api.github.com/installation/repositories?per_page=100', { headers: githubHeaders(token) });
  const now = new Date().toISOString();
  const statements = [
    env.METADATA.prepare(
      `INSERT INTO github_installations
        (installation_id, tenant_id, account_login, permission_snapshot, last_verified_at, account_id, account_type, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active')
       ON CONFLICT(installation_id) DO UPDATE SET tenant_id=excluded.tenant_id, account_login=excluded.account_login,
         permission_snapshot=excluded.permission_snapshot, last_verified_at=excluded.last_verified_at,
         account_id=excluded.account_id, account_type=excluded.account_type, status='active'`
    ).bind(String(installation.id), user.tenant_id, installation.account.login, JSON.stringify(installation.permissions), now, String(installation.account.id), installation.account.type)
  ];
  for (const repository of repositories.repositories) {
    statements.push(env.METADATA.prepare(
      `INSERT INTO repositories
        (id, tenant_id, project_id, provider, owner, name, installation_id, authorization_state, last_verified_at,
         github_repository_id, visibility, default_branch)
       VALUES (?1, ?2, ?3, 'github', ?4, ?5, ?6, 'authorized', ?7, ?8, ?9, ?10)
       ON CONFLICT(provider, owner, name, tenant_id) DO UPDATE SET installation_id=excluded.installation_id,
         authorization_state='authorized', last_verified_at=excluded.last_verified_at,
         github_repository_id=excluded.github_repository_id, visibility=excluded.visibility, default_branch=excluded.default_branch`
    ).bind(
      await id('repo', `${user.tenant_id}:${repository.id}`), user.tenant_id, user.project_id,
      repository.owner.login, repository.name, String(installation.id), now, String(repository.id),
      repository.private ? 'private' : 'public', repository.default_branch
    ));
  }
  await env.METADATA.batch(statements);
  return repositories.repositories.length;
}

export async function finishGitHubInstall(request: Request, env: Env): Promise<Response> {
  const user = await getWebSession(request, env);
  if (!user) return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=${encodeURIComponent(request.url)}`, 302);
  const installationId = new URL(request.url).searchParams.get('installation_id') ?? '';
  if (!/^\d+$/.test(installationId)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'GitHub installation ID is invalid.', retryable: false });
  const existing = await env.METADATA.prepare('SELECT tenant_id FROM github_installations WHERE installation_id=?1')
    .bind(installationId).first<{ tenant_id: string }>();
  if (existing && existing.tenant_id !== user.tenant_id) throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'This installation belongs to another Forge account.', retryable: false });
  if (!existing) {
    const state = new URL(request.url).searchParams.get('state') ?? '';
    const stateRow = await env.METADATA.prepare(
      'SELECT user_id, expires_at, used_at FROM github_install_states WHERE state_hash=?1'
    ).bind(await hash(state)).first<{ user_id: string; expires_at: string; used_at: string | null }>();
    if (!stateRow || stateRow.user_id !== user.id || stateRow.used_at || Date.parse(stateRow.expires_at) <= Date.now()) {
      throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'GitHub installation setup was not initiated by this Forge account.', retryable: false });
    }
    await env.METADATA.prepare('UPDATE github_install_states SET used_at=?1 WHERE state_hash=?2 AND used_at IS NULL')
      .bind(new Date().toISOString(), await hash(state)).run();
  }
  await syncInstallation(env, user, installationId);
  return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/app`, 302);
}

export async function listAuthorizedRepositories(env: Env, tenantId: string): Promise<Array<Record<string, unknown>>> {
  const result = await env.METADATA.prepare(
    `SELECT owner, name, visibility, default_branch, installation_id, last_verified_at
       FROM repositories WHERE tenant_id = ?1 AND authorization_state = 'authorized' ORDER BY owner, name`
  ).bind(tenantId).all<Record<string, unknown>>();
  return result.results;
}

export async function appDashboard(request: Request, env: Env): Promise<Response> {
  const user = await getWebSession(request, env);
  if (!user) return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=${encodeURIComponent('/app')}`, 302);
  const caps = workspaceCaps(env);
  const [repositories, occupants] = await Promise.all([
    listAuthorizedRepositories(env, user.tenant_id),
    listSlotOccupants(env.METADATA, slotTtlMs(env), Date.now(), user.tenant_id).catch(() => [])
  ]);
  const usedSlots = occupants.length;
  const ttlMinutes = Math.round(slotTtlMs(env) / 60_000);
  const occupantRow = (occupant: (typeof occupants)[number]) => {
    const idle = occupant.idleMinutes === null ? '—' : `${occupant.idleMinutes}m idle`;
    const state = occupant.state ?? 'unknown';
    const flag = occupant.stale ? ' · reclaimable' : '';
    return `<li><span><strong>Slot ${occupant.slot}</strong><small>${escapeHtml(occupant.workspaceId.slice(0, 14))}… · ${escapeHtml(state)} · ${escapeHtml(idle)}${flag}</small></span></li>`;
  };
  const occupantRows = occupants.length
    ? `<ul>${occupants.map(occupantRow).join('')}</ul>`
    : `<p class="note">All ${caps.perTenant} workspace slots are free.</p>`;
  const repositoryRow = (repo: Record<string, unknown>) => `<li><span><strong>${escapeHtml(String(repo.owner))}/${escapeHtml(String(repo.name))}</strong><small>${escapeHtml(String(repo.visibility))} · ${escapeHtml(String(repo.default_branch))}</small></span></li>`;
  const rows = repositories.length
    ? repositories.slice(0, 6).map(repositoryRow).join('')
    : '<li><span><strong>No repositories connected</strong><small>Install the GitHub App to build, edit and create draft PRs.</small></span></li>';
  const moreRows = repositories.length > 6
    ? `<details><summary>Show ${repositories.length - 6} more repositories</summary><ul>${repositories.slice(6).map(repositoryRow).join('')}</ul></details>`
    : '';
  const mcpUrl = `${env.FORGE_PUBLIC_ORIGIN}/mcp`;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forge Cloud</title><style>:root{--bg:#f5f5f8;--surface:#fff;--ink:#16161a;--muted:#6b6b76;--line:#e6e6ea;--soft:#f0f0f3;--accent:#5b4cf0;--grad:#a78bfa;--accent-soft:#efedfe}*{box-sizing:border-box}html,body{max-width:100%;overflow-x:clip}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}main{width:min(100% - 3rem,960px);margin:0 auto;padding:42px 0 72px}header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:28px;border-bottom:1px solid var(--line)}.mark{display:inline-flex;align-items:center;gap:10px;margin-bottom:14px}.mark .glyph{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--grad));display:grid;place-items:center;color:#fff;font-size:17px;box-shadow:0 3px 12px -3px var(--accent)}.mark .wordmark{font-size:19px;font-weight:750;letter-spacing:-.02em}h1{display:flex;align-items:center;gap:12px;font-size:32px;line-height:1;letter-spacing:-.035em;margin:0 0 12px}h1 .glyph{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--grad));display:grid;place-items:center;color:#fff;font-size:19px;box-shadow:0 3px 12px -3px var(--accent)}h2{font-size:18px;line-height:1.25;margin:0 0 10px}p{margin:0;color:var(--muted);max-width:68ch;text-wrap:pretty}.toplinks{display:flex;gap:14px;align-items:center;white-space:nowrap}a{color:inherit;text-underline-offset:3px}.button{display:inline-flex;min-height:44px;align-items:center;background:linear-gradient(135deg,var(--accent),var(--grad));color:#fff;padding:9px 14px;border-radius:9px;text-decoration:none;font-weight:700;transition:filter 180ms ease-out}.button:hover{filter:brightness(1.08)}a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.layout{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(250px,.8fr);gap:clamp(30px,5vw,54px);padding-top:34px}.layout>*{min-width:0}.section{margin-bottom:34px}.prompt{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;margin-top:10px;color:var(--ink);font:14px/1.55 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}.prompt+.prompt{margin-top:8px}.meter{display:flex;align-items:center;gap:10px;margin-top:12px}.slots{display:flex;gap:5px}.slot{width:32px;height:8px;border-radius:4px;background:var(--soft)}.slot.used{background:var(--accent)}code{display:block;max-width:100%;background:var(--soft);border-radius:6px;padding:11px;overflow:auto;margin:10px 0;color:var(--ink);overflow-wrap:anywhere}ul{list-style:none;margin:8px 0 0;padding:0;border-top:1px solid var(--line)}li{padding:11px 0;border-bottom:1px solid var(--line)}li span{display:flex;justify-content:space-between;gap:12px}small{color:var(--muted)}.note{font-size:13px;margin-top:10px}details{margin-top:10px}summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--muted);font-size:13px}summary:hover{color:var(--ink)}@media(max-width:720px){main{width:min(100% - 2.5rem,960px);padding:28px 0 56px}.layout{grid-template-columns:1fr;gap:8px}header{align-items:flex-start;flex-direction:column}.toplinks{width:100%;justify-content:space-between}li span{display:block}small{display:block}.button{justify-content:center;width:100%}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}</style>
<main><header><div><h1><span class="glyph" aria-hidden="true">⚒</span>Forge</h1><p>A real development computer for ChatGPT, Codex and Claude. Review a site cheaply, or open a repository to build, fix, test and prepare a draft PR.</p></div><div class="toplinks"><span>${escapeHtml(user.github_login)}</span><a href="/logout">Sign out</a></div></header>
<div class="layout"><div><section class="section"><h2>Start in your AI client</h2><p>Connect this MCP URL once, then use ordinary language. Forge chooses the smallest capable path.</p><code id="mcp">${mcpUrl}</code><a class="button" href="#" onclick="navigator.clipboard.writeText(document.querySelector('#mcp').textContent);this.textContent='Copied';return false">Copy MCP URL</a></section>
<section class="section"><h2>Good first prompts</h2><div class="prompt">Review https://example.com with Parallax on phone and desktop. Inspect every screenshot.</div><div class="prompt">Open ${escapeHtml(user.github_login)}/parallax-review, run the checks, explain the architecture, and do not change anything yet.</div><div class="prompt">Build my project, fix the most important issue, verify it with screenshots, then ask before creating a draft PR.</div></section>
<section class="section"><h2>How Forge keeps cost down</h2><p>Live URLs use Browser Run without a container. Repository inspection uses GitHub. A container starts only for install, build, edit, test or preview work, and sleeps after 90 seconds idle.</p></section></div>
<aside><section class="section"><h2>Workspace capacity</h2><div class="meter"><div class="slots">${Array.from({ length: caps.perTenant }, (_, index) => `<i class="slot ${usedSlots > index ? 'used' : ''}"></i>`).join('')}</div><span>${usedSlots} of ${caps.perTenant} active</span></div>${occupantRows}<p class="note">Each account runs up to ${caps.perTenant} workspaces (${caps.global} across all accounts). Idle workspaces are reclaimed automatically after ${ttlMinutes} minutes; destroy one sooner to free a slot immediately.</p></section>
<section class="section"><h2>GitHub repositories</h2><a class="button" href="/github/install">Manage access</a><ul>${rows}</ul>${moreRows}</section></aside></div></main>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function authorizeRepository(
  env: Env,
  identity: Pick<AuthenticatedContext, 'tenantId' | 'projectId'>,
  repository: RepositoryRef
): Promise<RepositoryRow | null> {
  const row = await env.METADATA.prepare(
    `SELECT installation_id, tenant_id, project_id, owner, name, authorization_state, visibility, default_branch
       FROM repositories WHERE tenant_id = ?1 AND project_id = ?2 AND owner = ?3 AND name = ?4 AND authorization_state = 'authorized'`
  ).bind(identity.tenantId, identity.projectId, repository.owner, repository.name).first<RepositoryRow>();
  if (row) return row;
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`, { headers: githubHeaders() });
  if (response.ok) {
    const value = await response.json() as { private?: boolean };
    if (!value.private) return null;
  }
  throw new ForgeError({
    code: 'FORGE_PERMISSION_DENIED',
    message: 'Install the Forge GitHub App for this repository before creating a workspace.',
    retryable: false,
    details: { install_url: `${env.FORGE_PUBLIC_ORIGIN}/github/install` }
  });
}

export async function repositoryCloneSource(env: Env, workspace: Workspace): Promise<{
  url: string;
  authorizationHeader?: string;
}> {
  const row = await authorizeRepository(env, { tenantId: workspace.tenantId, projectId: workspace.projectId }, workspace.repository);
  if (!row) return { url: `https://github.com/${workspace.repository.owner}/${workspace.repository.name}.git` };
  const now = Math.floor(Date.now() / 1000);
  const capability = await issueCapability({
    version: 1,
    subject: workspace.createdBy.type === 'agent' ? workspace.createdBy.id : 'forge-workspace',
    tenantId: workspace.tenantId,
    workspaceId: workspace.id,
    repository: `${workspace.repository.owner}/${workspace.repository.name}`,
    action: 'git:clone',
    nonce: crypto.randomUUID(),
    issuedAt: now,
    expiresAt: now + 10 * 60
  }, env.FORGE_CAPABILITY_SIGNING_KEY);
  return {
    url: `${env.FORGE_PUBLIC_ORIGIN}/git/${workspace.id}/${workspace.repository.owner}/${workspace.repository.name}.git`,
    authorizationHeader: `Authorization: Bearer ${capability}`
  };
}

export async function repositoryPushSource(env: Env, workspace: Workspace, branch: string, commit: string): Promise<{
  url: string;
  authorizationHeader: string;
}> {
  const row = await authorizeRepository(env, { tenantId: workspace.tenantId, projectId: workspace.projectId }, workspace.repository);
  if (!row) throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'Install the Forge GitHub App before pushing.', retryable: false });
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'The approved Git commit is unavailable.', retryable: false });
  const now = Math.floor(Date.now() / 1000);
  const capability = await issueCapability({
    version: 1,
    subject: workspace.createdBy.type === 'agent' ? workspace.createdBy.id : 'forge-workspace',
    tenantId: workspace.tenantId,
    workspaceId: workspace.id,
    repository: `${workspace.repository.owner}/${workspace.repository.name}`,
    action: 'git:push',
    branchPattern: branch,
    gitCommit: commit,
    nonce: crypto.randomUUID(),
    issuedAt: now,
    expiresAt: now + 5 * 60
  }, env.FORGE_CAPABILITY_SIGNING_KEY);
  return {
    url: `${env.FORGE_PUBLIC_ORIGIN}/git/${workspace.id}/${workspace.repository.owner}/${workspace.repository.name}.git`,
    authorizationHeader: `Authorization: Bearer ${capability}`
  };
}

function bearer(request: Request): string {
  return request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
}

async function inspectReceivePackBody(body: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<{
  body: ReadableStream<Uint8Array<ArrayBuffer>>;
  commands: ReturnType<typeof parseReceivePackCommands>;
}> {
  const [inspection, upstream] = body.tee();
  const reader = inspection.getReader();
  let buffered = new Uint8Array();
  try {
    while (buffered.byteLength <= 65_536) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = new Uint8Array(buffered.byteLength + value.byteLength);
      next.set(buffered);
      next.set(value, buffered.byteLength);
      buffered = next;
      const commands = parseReceivePackCommands(buffered);
      if (commands) {
        await reader.cancel();
        return { body: upstream, commands };
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await upstream.cancel().catch(() => undefined);
    throw error;
  }
  await reader.cancel().catch(() => undefined);
  await upstream.cancel().catch(() => undefined);
  throw new Error('Git receive-pack command section is missing or too large.');
}

export async function gitCredentialProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/git\/(ws_[^/]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git\/(.+)$/u);
  if (!match) return new Response('Not found', { status: 404 });
  const [, workspaceId = '', owner = '', name = '', rest = ''] = match;
  const push = rest.includes('receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
  const claims = await verifyCapability(bearer(request), env.FORGE_CAPABILITY_SIGNING_KEY, {
    workspaceId,
    action: push ? 'git:push' : 'git:clone',
    repository: `${owner}/${name}`
  });
  if (claims.repository !== `${owner}/${name}`) {
    throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Git capability is outside its repository or operation scope.', retryable: false });
  }
  const repository = await env.METADATA.prepare(
    `SELECT installation_id, name FROM repositories
      WHERE tenant_id = ?1 AND owner = ?2 AND name = ?3 AND authorization_state = 'authorized'`
  ).bind(claims.tenantId, owner, name).first<{ installation_id: string; name: string }>();
  if (!repository) throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Repository authorization was revoked.', retryable: false });
  let upstreamBody = request.body;
  if (push && request.method === 'POST') {
    if (!upstreamBody || !claims.branchPattern || !claims.gitCommit) {
      throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Git push capability is missing its approved branch or commit.', retryable: false });
    }
    try {
      const inspected = await inspectReceivePackBody(upstreamBody);
      assertReceivePackScope(inspected.commands, claims.branchPattern, claims.gitCommit);
      upstreamBody = inspected.body;
    } catch {
      throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Git push is outside its approved branch or commit scope.', retryable: false });
    }
  }
  const token = await installationToken(env, repository.installation_id, repository.name, push ? 'write' : 'read');
  const upstream = new URL(`https://github.com/${owner}/${name}.git/${rest}`);
  upstream.search = url.search;
  const headers = new Headers(request.headers);
  headers.set('authorization', `Basic ${btoa(`x-access-token:${token}`)}`);
  headers.delete('cookie');
  headers.delete('host');
  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : upstreamBody,
    redirect: 'manual'
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('set-cookie');
  responseHeaders.set('cache-control', 'private,no-store');
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

export async function requestApproval(
  env: Env,
  identity: Pick<AuthenticatedContext, 'tenantId' | 'subject'>,
  workspaceId: string,
  action: 'git.push' | 'pull_request.create' | 'shell.exec' | 'task.push_envelope',
  reason: string,
  payload: Record<string, unknown>
): Promise<{ approval_id: string; approval_url: string; expires_at: string; already_approved: boolean }> {
  const requestPayload = JSON.stringify({ ...payload, requestedBy: identity.subject });
  const nowIso = new Date().toISOString();
  // Reuse an existing non-expired approval for the identical request instead of
  // minting a new row. Covers both 'pending' (an agent retry-loop would otherwise
  // spam the human with N identical approval pages) and 'approved' (the human
  // already clicked approve but the agent hasn't consumed it yet — e.g. a
  // reconnect or retry between approval and execution — so asking again for the
  // literal same operation is pure friction, not a safety check). Approvals that
  // are 'executing'/'completed'/'failed' are correctly excluded: one approval is
  // still exactly one execution attempt.
  const existing = await env.METADATA.prepare(
    `SELECT id, expires_at, state FROM approvals
      WHERE tenant_id=?1 AND workspace_id=?2 AND requested_action=?3 AND request_payload=?4
        AND state IN ('pending','approved') AND expires_at > ?5
      ORDER BY expires_at DESC LIMIT 1`
  ).bind(identity.tenantId, workspaceId, action, requestPayload, nowIso).first<{ id: string; expires_at: string; state: string }>();
  if (existing) {
    const signed = await signApprovalLink(env, existing.id, identity.tenantId, existing.expires_at);
    return {
      approval_id: existing.id,
      approval_url: `${env.FORGE_PUBLIC_ORIGIN}/approvals/${existing.id}?t=${signed}`,
      expires_at: existing.expires_at,
      already_approved: existing.state === 'approved'
    };
  }
  const approvalId = ids.approval();
  // A real build+push cycle easily exceeds a few minutes, so a short approval
  // window forces re-approval. Default 120 min (was 60 — too short for a real
  // multi-step review-then-push session); tune with FORGE_APPROVAL_TTL_MINUTES.
  const ttlMinutes = Number(env.FORGE_APPROVAL_TTL_MINUTES);
  const minutes = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 120;
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  await env.METADATA.prepare(
    `INSERT INTO approvals
      (id, tenant_id, workspace_id, requested_action, reason, risk_category, request_payload, state, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'external_write', ?6, 'pending', ?7)`
  ).bind(approvalId, identity.tenantId, workspaceId, action, reason, requestPayload, expiresAt).run();
  const signed = await signApprovalLink(env, approvalId, identity.tenantId, expiresAt);
  return {
    approval_id: approvalId,
    approval_url: `${env.FORGE_PUBLIC_ORIGIN}/approvals/${approvalId}?t=${signed}`,
    expires_at: expiresAt,
    already_approved: false
  };
}

export async function requireApproval(
  env: Env,
  identity: Pick<AuthenticatedContext, 'tenantId'>,
  approvalId: string,
  workspaceId: string,
  action: 'git.push' | 'pull_request.create' | 'shell.exec' | 'task.push_envelope',
  expected: Record<string, unknown>
): Promise<void> {
  const row = await env.METADATA.prepare(
    `SELECT request_payload, state, expires_at FROM approvals
      WHERE id=?1 AND tenant_id=?2 AND workspace_id=?3 AND requested_action=?4`
  ).bind(approvalId, identity.tenantId, workspaceId, action).first<{ request_payload: string; state: string; expires_at: string }>();
  // Distinct, actionable failures so an agent knows whether to wait, re-request,
  // or rebuild the diff — instead of one ambiguous "approval required" for all.
  if (!row) {
    throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'No matching approval. Request one, open the approval URL, then retry with approval_id.', retryable: false });
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new ForgeError({ code: 'FORGE_APPROVAL_EXPIRED', message: 'This approval expired. Request a new one and have it approved, then retry.', retryable: false });
  }
  if (row.state !== 'approved') {
    throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: row.state === 'pending' ? 'Approval is still pending — wait for it to be approved in the browser, then retry.' : 'This approval was already used. Request a new one.', retryable: false });
  }
  const payload = JSON.parse(row.request_payload) as Record<string, unknown>;
  const changed: Array<{ field: string; approved: unknown; current: unknown }> = [];
  for (const [key, value] of Object.entries(expected)) {
    if (payload[key] !== value) changed.push({ field: key, approved: payload[key], current: value });
  }
  if (changed.length > 0) {
    // Name exactly what moved instead of a bare "state mismatch" — an agent
    // (or a human reading the error) can tell at a glance whether this is a
    // meaningful drift (diffHash changed: new commits landed) or something
    // trivial, without re-deriving it themselves.
    throw new ForgeError({
      code: 'FORGE_APPROVAL_REQUIRED',
      message: `The operation changed since it was approved: ${changed.map((c) => `${c.field} was ${String(c.approved)}, is now ${String(c.current)}`).join('; ')}. Re-run forge_git_outgoing_diff and request a fresh approval.`,
      retryable: false,
      details: { changed }
    });
  }
  const claimed = await env.METADATA.prepare("UPDATE approvals SET state='executing' WHERE id=?1 AND state='approved'")
    .bind(approvalId).run();
  if ((claimed.meta.changes ?? 0) !== 1) throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'This approval has already been used.', retryable: false });
}

/**
 * Resolve a pending approval as approved without the human ever loading the
 * HTML approval page — used when they consented through an inline MCP
 * elicitation instead (see elicitInlineApproval). Mirrors approvalPage's own
 * POST handler exactly (same state transition, same resolved_by shape) so a
 * later forge_task_get/audit read can't tell the two paths apart except by
 * resolved_by.
 */
export async function markApprovalApproved(env: Env, tenantId: string, approvalId: string): Promise<boolean> {
  const result = await env.METADATA.prepare(
    "UPDATE approvals SET state='approved', resolved_by='inline-elicitation', resolved_at=?1 WHERE id=?2 AND tenant_id=?3 AND state='pending' AND expires_at > ?1"
  ).bind(new Date().toISOString(), approvalId, tenantId).run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Settle an approval after its operation ran.
 *
 * External writes (git.push, pull_request.create) stay strictly one-approval-one-
 * execution: the thing they authorize is irreversible and leaves Forge, so a
 * second push must mean a second human decision.
 *
 * In-workspace shell is different. Its approval is scoped to one exact command in
 * one workspace, and the iterate-run-fix loop re-runs that identical command over
 * and over. Spending the approval on first use meant a human click per iteration
 * of a test-fix cycle — friction with no corresponding decision, since the human
 * already said yes to precisely this command. So a successful shell approval is
 * re-armed to 'approved' and can be reused for the same command until its TTL
 * expires. A *failed* one is still spent, so a command that keeps erroring cannot
 * be retried indefinitely without the human seeing it again.
 */
export async function completeApproval(
  env: Env,
  approvalId: string,
  succeeded: boolean,
  options: { reusable?: boolean } = {}
): Promise<void> {
  const nextState = succeeded ? (options.reusable ? 'approved' : 'consumed') : 'failed';
  await env.METADATA.prepare('UPDATE approvals SET state=?1 WHERE id=?2 AND state=\'executing\'')
    .bind(nextState, approvalId).run();
}

/** Actions whose approval may be reused for an identical repeat within its TTL. */
export function approvalIsReusable(action: string): boolean {
  return action === 'shell.exec';
}

interface DiffRow {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

interface DiffFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  rows: DiffRow[];
}

// Parse a unified diff into per-file, line-numbered structure so the approval
// page can render a real side-by-gutter view instead of a raw text blob.
function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/ b\/(.+)$/u);
      current = { path: match?.[1] ?? line.replace('diff --git ', ''), added: 0, removed: 0, binary: false, rows: [] };
      files.push(current);
      oldNo = 0;
      newNo = 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('rename to ')) { current.path = line.slice('rename to '.length); continue; }
    if (line.startsWith('Binary files')) { current.binary = true; continue; }
    if (
      line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') ||
      line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity ') ||
      line.startsWith('rename from ') || line.startsWith('old mode') || line.startsWith('new mode') ||
      line.startsWith('\\ No newline')
    ) continue;
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
      oldNo = match ? Number(match[1]) : 0;
      newNo = match ? Number(match[2]) : 0;
      current.rows.push({ type: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith('+')) { current.added += 1; current.rows.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ }); }
    else if (line.startsWith('-')) { current.removed += 1; current.rows.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null }); }
    else { current.rows.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ }); }
  }
  return files;
}

const fileGlyph = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return '𝐉𝐒';
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '⚙';
  if (['md', 'txt'].includes(ext)) return '📄';
  if (['css', 'scss', 'html'].includes(ext)) return '🎨';
  if (['sql'].includes(ext)) return '🗄';
  return '›';
};

// Render the parsed diff as color-coded file cards with old/new line-number
// gutters. Bounded so a huge diff can't blow up the page; the diffHash (not
// this display) remains the integrity check on what actually gets pushed.
function renderDiffHtml(diff: string): string {
  const MAX_ROWS = 4000;
  const files = parseDiff(diff);
  let budget = MAX_ROWS;
  let truncated = 0;
  const cards = files.map((file) => {
    const gutter = (value: number | null): string => (value === null ? '' : String(value));
    const rows = file.rows.slice(0, budget);
    truncated += file.rows.length - rows.length;
    budget -= rows.length;
    const body = file.binary
      ? '<div class="drow ctx"><span class="dg"></span><span class="dg"></span><span class="dc">Binary file not shown</span></div>'
      : rows.map((row) => {
          const sign = row.type === 'add' ? '+' : row.type === 'del' ? '−' : row.type === 'hunk' ? '' : ' ';
          return `<div class="drow ${row.type}"><span class="dg">${gutter(row.oldNo)}</span><span class="dg">${gutter(row.newNo)}</span><span class="dc"><span class="ds">${sign}</span>${escapeHtml(row.text) || ' '}</span></div>`;
        }).join('');
    return `<section class="dfile"><header class="dfhead"><span class="dfico" aria-hidden="true">${fileGlyph(file.path)}</span><span class="dfpath">${escapeHtml(file.path)}</span><span class="dfstat"><span class="s-add">+${file.added}</span><span class="s-del">−${file.removed}</span></span></header><div class="dfbody">${body}</div></section>`;
  }).join('');
  const trailer = truncated > 0 ? `<p class="dtrunc">… ${truncated} more line${truncated === 1 ? '' : 's'} truncated — review the full diff in the workspace before approving.</p>` : '';
  return `<div class="diffset">${cards}${trailer}</div>`;
}

// Cheap +adds / -dels / files summary for the approval header.
function diffStats(diff: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { files, added, removed };
}

export async function approvalPage(request: Request, env: Env, approvalId: string): Promise<Response> {
  const url = new URL(request.url);
  // Prefer a signed link (open + approve from the transcript, no re-login). Fall
  // back to the logged-in web session. Both resolve to a tenant scope; only then
  // do we redirect to GitHub login.
  const token = url.searchParams.get('t') ?? '';
  const linkClaims = token ? await verifyApprovalLink(env, token, approvalId) : null;
  const user = linkClaims ? null : await getWebSession(request, env);
  const tenantId = linkClaims?.tenant ?? user?.tenant_id ?? null;
  if (!tenantId) return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=${encodeURIComponent(request.url)}`, 302);
  const resolvedBy = user ? `github:${user.github_user_id}` : 'approval-link';
  // Preserve the signed token across the POST → 303 → GET round-trip so the
  // reviewer never bounces to login mid-decision.
  const selfUrl = `${env.FORGE_PUBLIC_ORIGIN}/approvals/${approvalId}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
  const row = await env.METADATA.prepare(
    'SELECT requested_action, reason, request_payload, state, expires_at FROM approvals WHERE id=?1 AND tenant_id=?2'
  ).bind(approvalId, tenantId).first<{ requested_action: string; reason: string; request_payload: string; state: string; expires_at: string }>();
  if (!row) return new Response('Approval not found', { status: 404 });
  if (request.method === 'POST') {
    assertSameOrigin(request, env);
    if (row.state !== 'pending' || Date.parse(row.expires_at) <= Date.now()) return new Response('Approval expired', { status: 409 });
    const body = new URLSearchParams(await request.text());
    const decision = body.get('decision');
    if (decision !== 'approved' && decision !== 'denied') return new Response('Invalid decision', { status: 400 });
    await env.METADATA.prepare('UPDATE approvals SET state=?1, resolved_by=?2, resolved_at=?3 WHERE id=?4 AND state=\'pending\'')
      .bind(decision, resolvedBy, new Date().toISOString(), approvalId).run();
    return Response.redirect(selfUrl, 303);
  }
  const payload = JSON.parse(row.request_payload) as Record<string, unknown>;
  // Pull out the display-only diff/body; show the rest as a small key/value
  // list so the human approves what they can actually read, not a raw hash blob.
  const { diff, body, ...meta } = payload as { diff?: string; body?: string; [key: string]: unknown };
  const metaRows = Object.entries(meta)
    .filter(([, value]) => value !== '' && value !== undefined && value !== null)
    .map(([key, value]) => `<div class="kv"><span>${escapeHtml(key)}</span><code>${escapeHtml(String(value))}</code></div>`)
    .join('');
  const hasDiff = typeof diff === 'string' && diff.trim() !== '';
  const stats = hasDiff ? diffStats(diff) : null;
  const statsLine = stats
    ? `<p class="stats"><b>${stats.files}</b> file${stats.files === 1 ? '' : 's'} · <span class="s-add">+${stats.added}</span> <span class="s-del">−${stats.removed}</span></p>`
    : '';
  const bodyBlock = typeof body === 'string' && body.trim() !== '' ? `<pre class="body">${escapeHtml(body)}</pre>` : '';
  const contentBlock = hasDiff
    ? renderDiffHtml(diff)
    : metaRows === ''
      ? `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`
      : '';
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forge approval</title><style>:root{--bg:#f5f5f8;--surface:#fff;--ink:#16161a;--muted:#6b6b76;--line:#e6e6ea;--accent:#5b4cf0;--grad:#a78bfa;--add:#eafaf0;--add-ink:#0f9d58;--del:#fdecec;--del-ink:#d64545;--hunk:#efedfe;--hunk-ink:#5b4cf0}*{box-sizing:border-box}body{width:min(100% - 2.5rem,60rem);margin:0 auto;padding:clamp(2.5rem,8vw,5rem) 0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}.mark{display:inline-flex;align-items:center;gap:10px;margin-bottom:1.4rem}.mark .glyph{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--grad));display:grid;place-items:center;color:#fff;font-size:17px;box-shadow:0 3px 12px -3px var(--accent)}.mark .wordmark{font-size:18px;font-weight:750;letter-spacing:-.02em}h1{margin:0 0 1rem;font-size:clamp(1.9rem,6vw,2.8rem);line-height:1.02;letter-spacing:-.03em}p{color:var(--muted);overflow-wrap:anywhere}.stats{color:var(--ink);font-weight:600}.s-add{color:var(--add-ink)}.s-del{color:var(--del-ink)}.kv{display:flex;gap:.75rem;align-items:baseline;padding:.3rem 0;border-bottom:1px solid var(--line)}.kv span{flex:0 0 6.5rem;color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}.kv code{overflow-wrap:anywhere}pre{max-width:100%;overflow:auto;background:var(--surface);padding:1rem;border:1px solid var(--line);border-radius:10px;font:.82rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}pre.body{white-space:pre-wrap;overflow-wrap:anywhere;max-height:16rem}.diffset{margin-top:1.25rem;display:flex;flex-direction:column;gap:1rem}.dfile{border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--surface)}.dfhead{display:flex;align-items:center;gap:.6rem;padding:.6rem .9rem;background:#fafafc;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:1}.dfico{font-size:.72rem;font-weight:800;color:var(--muted);min-width:1.6rem;text-align:center}.dfpath{font:600 .82rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dfstat{margin-left:auto;display:flex;gap:.5rem;font:700 .74rem/1 ui-monospace,monospace;flex:0 0 auto}.dfbody{max-height:30rem;overflow:auto;font:.8rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.drow{display:grid;grid-template-columns:3rem 3rem 1fr;min-width:0}.drow .dg{padding:0 .45rem;text-align:right;color:var(--muted);opacity:.6;user-select:none;white-space:nowrap;border-right:1px solid var(--line)}.drow .dc{padding:0 .75rem;white-space:pre;overflow-wrap:normal}.drow .ds{display:inline-block;width:.75rem;color:var(--muted);opacity:.7}.drow.add{background:var(--add)}.drow.add .dc,.drow.add .ds{color:var(--add-ink)}.drow.del{background:var(--del)}.drow.del .dc,.drow.del .ds{color:var(--del-ink)}.drow.hunk{background:var(--hunk)}.drow.hunk .dc{color:var(--hunk-ink);font-weight:600}.drow.hunk .dg{background:var(--hunk);border-right-color:transparent}.dtrunc{font-size:.8rem;margin-top:.25rem}form{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.5rem;position:sticky;bottom:1rem}button{min-height:46px;padding:.7rem 1.2rem;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);font:inherit;font-weight:700;cursor:pointer;transition:filter 180ms ease-out,border-color 180ms ease-out}.approve{background:linear-gradient(135deg,var(--accent),var(--grad));color:#fff;border-color:transparent}button:hover{border-color:var(--accent)}.approve:hover{filter:brightness(1.08);border-color:transparent}button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}@media(max-width:460px){form{flex-direction:column}button{width:100%}}</style>
<div class="mark"><span class="glyph" aria-hidden="true">⚒</span><span class="wordmark">Forge</span></div><h1>${row.state === 'pending' ? 'Approve Forge action' : `Action ${escapeHtml(row.state)}`}</h1><p><strong>${escapeHtml(row.requested_action)}</strong></p><p>${escapeHtml(row.reason)}</p>${statsLine}${metaRows ? `<div class="meta">${metaRows}</div>` : ''}${bodyBlock}${contentBlock}
${row.state === 'pending' ? `<form method="post" action="${escapeHtml(selfUrl)}"><button class="approve" name="decision" value="approved">Approve once</button><button name="decision" value="denied">Deny</button></form>` : ''}`,
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function createDraftPullRequest(
  env: Env,
  identity: Pick<AuthenticatedContext, 'tenantId' | 'projectId'>,
  repository: RepositoryRef,
  input: { head: string; base: string; title: string; body: string }
): Promise<{ number: number; url: string; state: string }> {
  const row = await authorizeRepository(env, identity, repository);
  if (!row) throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'GitHub App authorization is required.', retryable: false });
  const token = await installationToken(env, row.installation_id, repository.name, 'write');
  const result = await githubJson<{ number: number; html_url: string; state: string }>(
    `https://api.github.com/repos/${repository.owner}/${repository.name}/pulls`,
    { method: 'POST', headers: githubHeaders(token), body: JSON.stringify({ ...input, draft: true }) }
  );
  return { number: result.number, url: result.html_url, state: result.state };
}

async function verifyWebhook(request: Request, secret: string): Promise<ArrayBuffer> {
  const body = await request.arrayBuffer();
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = signature.startsWith('sha256=')
    ? Uint8Array.from(signature.slice(7).match(/.{2}/g) ?? [], (value) => Number.parseInt(value, 16))
    : new Uint8Array();
  if (!(await crypto.subtle.verify('HMAC', key, bytes, body))) {
    throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'GitHub webhook signature is invalid.', retryable: false });
  }
  return body;
}

export async function githubWebhook(request: Request, env: Env): Promise<Response> {
  const body = await verifyWebhook(request, required(env.GITHUB_WEBHOOK_SECRET, 'GITHUB_WEBHOOK_SECRET'));
  const event = request.headers.get('x-github-event') ?? '';
  const payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  const installation = payload.installation as { id?: number } | undefined;
  if (installation?.id && (event === 'installation' || event === 'installation_repositories')) {
    const action = String(payload.action ?? '');
    if (['deleted', 'suspend', 'suspended'].includes(action)) {
      await env.METADATA.batch([
        env.METADATA.prepare("UPDATE github_installations SET status='revoked', last_verified_at=?1 WHERE installation_id=?2")
          .bind(new Date().toISOString(), String(installation.id)),
        env.METADATA.prepare("UPDATE repositories SET authorization_state='revoked', last_verified_at=?1 WHERE installation_id=?2")
          .bind(new Date().toISOString(), String(installation.id))
      ]);
    }
  }
  return new Response(null, { status: 204 });
}
