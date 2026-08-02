import { SignJWT, importPKCS8 } from 'jose';
import { ForgeError, ids, type ArtifactId, type RepositoryRef, type TenantId, type Workspace, type WorkspaceId } from '@forge/core';
import { issueCapability, verifyCapability } from '@forge/capabilities';
import type { GitHubRequest } from '@forge/git-github';
import { assertAllowedForgeBranch } from '@forge/policy';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import { R2ArtifactStore } from '@forge/artifacts-r2';
import type { AuthenticatedContext } from './auth';
import type { Env } from './env';
import { listSlotOccupants, slotTtlMs, workspaceCaps } from './capacity';
import { BASE_CSS, escapeHtml, forgeGlyph, page } from './ui';
import { launchReviewPreview, releaseReviewPreview, reviewPreviewStatus } from './review-preview';
import {
  denyDeferredAction,
  executeDeferredAction,
  getDeferredActionByApproval,
  listPendingDeferredActions,
  type DeferredAction
} from './deferred-actions';
import { dashboardFirstPrompts } from './mcp-guidance';

const GITHUB_API_VERSION = '2026-03-10';
const SESSION_SECONDS = 60 * 60 * 24 * 14;
const LOGIN_STATE_SECONDS = 10 * 60;
/** Default TTL for deferred work.submit — humans decide from the portal days later. */
const DEFERRED_APPROVAL_TTL_MINUTES = 14 * 24 * 60;

/** Sync approvals the portal surfaces alongside deferred submissions. */
export interface PendingSyncApproval {
  id: string;
  requestedAction: string;
  reason: string;
  expiresAt: string;
  workspaceId: string | null;
}

interface GitHubUser {
  id: number;
  login: string;
  avatar_url?: string;
}

export interface UserRow {
  id: string;
  github_user_id: string;
  github_login: string;
  access_state?: string;
  is_owner?: number;
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

export function cookie(request: Request, name: string): string {
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

function escapeHtmlLocal(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
}

/**
 * CSRF guard for form POSTs: the submission must come from a page Forge itself
 * served (FORGE_PUBLIC_ORIGIN).
 */
export function assertSameOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('origin');
  if (!origin) return;
  if (origin !== env.FORGE_PUBLIC_ORIGIN) throw new ForgeError({
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

/** Public helper so forge_merge can hand the human a signed URL on replay. */
export async function signedApprovalUrl(
  env: Env,
  approvalId: string,
  tenantId: string,
  expiresAtIso: string
): Promise<string> {
  const signed = await signApprovalLink(env, approvalId, tenantId, expiresAtIso);
  return `${env.FORGE_PUBLIC_ORIGIN}/approvals/${approvalId}?t=${signed}`;
}

/**
 * Pending sync approvals (shell / deploy / PR mutate / secret) for the portal
 * review queue. Deferred work.submit rows are listed separately via
 * deferred_actions — including them here would double-count.
 */
export async function listPendingSyncApprovals(
  env: Env,
  tenantId: string,
  limit = 50
): Promise<PendingSyncApproval[]> {
  const nowIso = new Date().toISOString();
  const result = await env.METADATA.prepare(
    `SELECT id, requested_action, reason, expires_at, workspace_id FROM approvals
      WHERE tenant_id=?1 AND state='pending' AND expires_at > ?2
        AND requested_action != 'work.submit'
      ORDER BY expires_at DESC LIMIT ?3`
  ).bind(tenantId, nowIso, limit).all<{
    id: string;
    requested_action: string;
    reason: string;
    expires_at: string;
    workspace_id: string | null;
  }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    requestedAction: row.requested_action,
    reason: row.reason,
    expiresAt: row.expires_at,
    workspaceId: row.workspace_id
  }));
}

/** Look up one approval row for remint / replay decisions. */
export async function getApprovalRecord(
  env: Env,
  tenantId: string,
  approvalId: string
): Promise<{ id: string; state: string; expiresAt: string } | null> {
  const row = await env.METADATA.prepare(
    'SELECT id, state, expires_at FROM approvals WHERE id=?1 AND tenant_id=?2'
  ).bind(approvalId, tenantId).first<{ id: string; state: string; expires_at: string }>();
  return row ? { id: row.id, state: row.state, expiresAt: row.expires_at } : null;
}

export function approvalStillUsable(row: { state: string; expiresAt: string } | null | undefined): boolean {
  if (!row) return false;
  if (row.state !== 'pending' && row.state !== 'approved') return false;
  return Date.parse(row.expiresAt) > Date.now();
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

/**
 * Mint a repository-scoped installation token, and keep what GitHub granted.
 *
 * The granted permissions are the only honest answer to "can Forge write
 * here". A repository object fetched with an installation token has no
 * `permissions` field — that field is populated for user tokens — so anything
 * reading `repo.permissions.push` concludes "no write access" for every
 * repository, forever. forge_access did exactly that and told two agents the
 * App was read-only while it held contents:write.
 *
 * GitHub refuses the mint outright when the installation lacks a requested
 * permission, so a successful write-scoped mint is itself the proof, and it is
 * the same proof forge_edit relies on rather than a parallel guess.
 */
async function mintInstallationToken(
  env: Env,
  installationId: string,
  repository: string,
  permission: 'read' | 'write'
): Promise<{ token: string; permissions: Record<string, string> }> {
  const result = await githubJson<{ token: string; permissions?: Record<string, string> }>(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: githubHeaders(await appJwt(env)),
      body: JSON.stringify({ repositories: [repository], permissions: { contents: permission, pull_requests: permission } })
    }
  );
  return { token: result.token, permissions: result.permissions ?? {} };
}

async function installationToken(
  env: Env,
  installationId: string,
  repository: string,
  permission: 'read' | 'write'
): Promise<string> {
  return (await mintInstallationToken(env, installationId, repository, permission)).token;
}

/**
 * What Forge can actually do to a repository right now, proved by minting the
 * same token the editing path uses. Never inferred from a repository object.
 */
export async function repositoryWriteProof(
  env: Env,
  identity: Pick<AuthenticatedContext, 'tenantId' | 'projectId'>,
  repository: RepositoryRef
): Promise<
  | { authorized: false }
  | { authorized: true; can_write: boolean; permissions: Record<string, string>; reason?: string }
> {
  const row = await authorizeRepository(env, identity, repository);
  if (!row) return { authorized: false };
  try {
    const granted = await mintInstallationToken(env, row.installation_id, repository.name, 'write');
    return {
      authorized: true,
      can_write: granted.permissions.contents === 'write',
      permissions: granted.permissions
    };
  } catch (error) {
    // A refused write-scoped mint is the real "cannot write" signal.
    return {
      authorized: true,
      can_write: false,
      permissions: {},
      reason: error instanceof Error ? error.message.slice(0, 300) : 'The installation token request failed.'
    };
  }
}

/**
 * The Forge origin for this request: FORGE_PUBLIC_ORIGIN.
 *
 * The request Host is attacker-controlled and this value ends up in an OAuth
 * redirect_uri, so unrecognised hosts must never be echoed back.
 */
export function forgeOrigin(request: Request, env: Env): string {
  try {
    if (new URL(request.url).origin === env.FORGE_PUBLIC_ORIGIN) return env.FORGE_PUBLIC_ORIGIN;
  } catch {
    // fall through
  }
  return env.FORGE_PUBLIC_ORIGIN;
}

export async function getWebSession(request: Request, env: Env): Promise<UserRow | null> {
  const token = cookie(request, 'forge_session');
  if (!token) return null;
  return env.METADATA.prepare(
    `SELECT u.id, u.github_user_id, u.github_login, u.avatar_url, u.tenant_id, u.project_id, u.access_state, u.is_owner
       FROM web_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2`
  ).bind(await hash(token), new Date().toISOString()).first<UserRow>();
}

export async function startGitHubLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const self = forgeOrigin(request, env);
  const requestedReturn = url.searchParams.get('return_to') ?? '/app';
  const candidate = new URL(requestedReturn, self);
  const returnUrl = candidate.origin === self ? candidate : new URL('/app', self);
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
  authorizeUrl.searchParams.set('redirect_uri', `${self}/login/github/callback`);
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
      // Must match the redirect_uri sent to /authorize exactly. GitHub sent the
      // visitor back to that same host, so deriving it from this request
      // reproduces it without having to store it alongside the state.
      redirect_uri: `${forgeOrigin(request, env)}/login/github/callback`
    }).toString()
  });
  if (!token.access_token) throw new ForgeError({ code: 'FORGE_AUTH_REQUIRED', message: 'GitHub did not issue a user authorization token.', retryable: false });
  const user = await githubJson<GitHubUser>('https://api.github.com/user', { headers: githubHeaders(token.access_token) });
  const userId = await id('usr', String(user.id));
  const tenantId = await id('ten', `github:${user.id}`);
  const projectId = await id('prj', `github:${user.id}:default`);
  const now = new Date().toISOString();
  // Identity is keyed on GitHub's immutable numeric user id, so a rename keeps
  // the same tenant, project and user row. What it does invalidate is every
  // stored repository owner — detect it here so we can repair those below.
  const previous = await env.METADATA.prepare('SELECT github_login FROM users WHERE github_user_id=?1')
    .bind(String(user.id)).first<{ github_login: string }>();
  const renamed = Boolean(previous && previous.github_login !== user.login);
  // Bootstrapping: with no accounts yet, whoever signs in first is the owner.
  // Checked before the insert below, and only used when creating a new row.
  const existingAccounts = await env.METADATA.prepare('SELECT COUNT(*) AS total FROM users')
    .first<{ total: number }>().catch(() => ({ total: 1 }));
  const isFirstAccount = (existingAccounts?.total ?? 1) === 0;
  await env.METADATA.batch([
    env.METADATA.prepare('INSERT OR IGNORE INTO tenants (id, name, status, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(tenantId, `${user.login} Forge`, 'active', now),
    env.METADATA.prepare('INSERT OR IGNORE INTO projects (id, tenant_id, name, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(projectId, tenantId, 'GitHub repositories', now),
    env.METADATA.prepare(
      `INSERT INTO users (id, github_user_id, github_login, avatar_url, tenant_id, project_id, created_at, updated_at,
                          access_state, is_owner, access_requested_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?7)
       ON CONFLICT(github_user_id) DO UPDATE SET github_login=excluded.github_login, avatar_url=excluded.avatar_url, updated_at=excluded.updated_at`
    ).bind(
      userId, String(user.id), user.login, user.avatar_url ?? null, tenantId, projectId, now,
      // The very first account to sign in is the owner and is approved outright;
      // there is nobody else who could have approved it. Everyone after that
      // lands pending and waits for the owner. Only ever applied on insert — the
      // upsert above deliberately does not touch access_state, so signing in
      // again can neither grant nor revoke access.
      isFirstAccount ? 'approved' : 'pending',
      isFirstAccount ? 1 : 0
    )
  ]);
  // Repair the stale owner logins a rename left behind, before the dashboard is
  // rendered from them. Never allowed to break the login itself.
  if (renamed) {
    await resyncTenantInstallations(env, {
      id: userId,
      github_user_id: String(user.id),
      github_login: user.login,
      avatar_url: user.avatar_url ?? null,
      tenant_id: tenantId,
      project_id: projectId
    } as UserRow);
  }
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
  if (!hasForgeAccess(user)) return accessPendingPage(env, user, user.access_state ?? 'pending');
  // This pilot deliberately uses a private GitHub App. Sending a collaborator
  // to GitHub's installation URL produces GitHub's indistinguishable 404, which
  // looks like a broken Forge button. The Forge owner installs/selects repos;
  // approved collaborators inherit that shared project and never install the
  // App themselves.
  if (user.is_owner !== 1) return privateAppInstallHelpPage(env);
  const state = randomToken('ghinstall');
  await env.METADATA.prepare('INSERT INTO github_install_states (state_hash, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await hash(state), user.id, new Date(Date.now() + LOGIN_STATE_SECONDS * 1000).toISOString()).run();
  const installUrl = new URL(`https://github.com/apps/${encodeURIComponent(required(env.GITHUB_APP_SLUG, 'GITHUB_APP_SLUG'))}/installations/new`);
  installUrl.searchParams.set('state', state);
  return Response.redirect(installUrl.toString(), 302);
}

/**
 * A slug freed by a rename can immediately be taken by a different repository.
 * Clear any row squatting on this (owner, name) that is not this repository, so
 * the UNIQUE(provider, owner, name, tenant_id) constraint cannot reject the
 * upsert below. GitHub is the source of truth for what exists.
 *
 * Exported so the rename regression test drives the real statement.
 */
export const REPOSITORY_SLUG_CLEAR_SQL =
  `DELETE FROM repositories
    WHERE tenant_id=?1 AND provider='github' AND owner=?2 AND name=?3 AND id<>?4`;

/**
 * Upsert one authorized repository, keyed on the stable row id.
 *
 * The row id derives from the tenant plus GitHub's immutable numeric repository
 * id, so it survives renames; owner and name are both mutable and are what a
 * rename moves. Conflicting on (provider, owner, name, tenant_id) instead meant
 * that after a rename the upsert matched nothing on that target and then hit the
 * primary key with no handler, failing with "UNIQUE constraint failed:
 * repositories.id" — and because the sync runs as one atomic batch, that took
 * down the entire installation sync and left every stored owner stale.
 *
 * Exported so the rename regression test drives the real statement.
 */
export const REPOSITORY_UPSERT_SQL =
  `INSERT INTO repositories
    (id, tenant_id, project_id, provider, owner, name, installation_id, authorization_state, last_verified_at,
     github_repository_id, visibility, default_branch)
   VALUES (?1, ?2, ?3, 'github', ?4, ?5, ?6, 'authorized', ?7, ?8, ?9, ?10)
   ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, name=excluded.name,
     installation_id=excluded.installation_id,
     authorization_state='authorized', last_verified_at=excluded.last_verified_at,
     github_repository_id=excluded.github_repository_id, visibility=excluded.visibility, default_branch=excluded.default_branch`;

/**
 * Re-sync every active installation for a tenant.
 *
 * Renaming a GitHub account changes the owner login on every repository, and
 * nothing else in Forge re-reads that: the only sync trigger is the GitHub App
 * install callback, so stale owners would otherwise persist until the user
 * happened to reinstall. Called when a rename is detected at sign-in and from the
 * rename-ish webhooks, so the portal repairs itself.
 *
 * Best-effort by contract: this must never be the reason a login fails.
 */
async function resyncTenantInstallations(env: Env, user: UserRow): Promise<void> {
  try {
    // Deliberately not filtered to status='active'. The state most in need of
    // repair is an installation marked revoked that is in fact live on GitHub —
    // which is exactly what a GitHub account rename can leave behind. Skipping
    // those meant the one case self-healing existed for was the one case it
    // could not reach. A genuinely dead installation simply fails its sync and
    // stays revoked.
    const rows = await env.METADATA.prepare(
      'SELECT installation_id FROM github_installations WHERE tenant_id=?1'
    ).bind(user.tenant_id).all<{ installation_id: string }>();
    for (const row of rows.results ?? []) {
      await syncInstallation(env, user, row.installation_id).catch((error) => {
        console.error('forge_resync_installation_failed', {
          installationId: row.installation_id,
          name: error instanceof Error ? error.name : 'unknown'
        });
      });
    }
  } catch (error) {
    console.error('forge_resync_tenant_failed', { name: error instanceof Error ? error.name : 'unknown' });
  }
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
    // Stable across renames: derived from the tenant plus GitHub's immutable
    // numeric repository id. See REPOSITORY_UPSERT_SQL.
    const rowId = await id('repo', `${user.tenant_id}:${repository.id}`);
    statements.push(env.METADATA.prepare(REPOSITORY_SLUG_CLEAR_SQL)
      .bind(user.tenant_id, repository.owner.login, repository.name, rowId));
    statements.push(env.METADATA.prepare(REPOSITORY_UPSERT_SQL).bind(
      rowId, user.tenant_id, user.project_id,
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
  if (!hasForgeAccess(user)) return accessPendingPage(env, user, user.access_state ?? 'pending');
  if (user.is_owner !== 1) return privateAppInstallHelpPage(env);
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


/**
 * Find this account's App installations by asking GitHub, and sync them.
 *
 * Until now Forge only learned that its App had been installed via the redirect
 * back from GitHub. That redirect is the single point of failure for the entire
 * repository half of the product: if the App's setup URL is not configured, if
 * the person installs from GitHub's own settings page, or if they simply close
 * the tab before being bounced back, Forge never hears about it and there is no
 * way to recover — the account looks permanently unconnected no matter how many
 * times the App is installed. Production hit exactly this: six install attempts,
 * five of which never reached the callback at all.
 *
 * So stop depending on being told. The App can enumerate its own installations,
 * so ask, and sync the ones that belong to the signed-in account.
 *
 * The ownership check is stricter than the redirect flow's was, not looser: an
 * installation is only adopted when GitHub says its account id is this user's
 * GitHub id. The old nonce proved the person started a flow; this proves the
 * installation is actually theirs.
 */
export async function reconnectGitHub(request: Request, env: Env): Promise<Response> {
  const user = await getWebSession(request, env);
  if (!user) return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=${encodeURIComponent('/app')}`, 302);
  if (!hasForgeAccess(user)) return accessPendingPage(env, user, user.access_state ?? 'pending');
  assertSameOrigin(request, env);
  // Installations belong to the pilot owner. A collaborator has no installation
  // to discover, so an attempted reconnect should explain that instead of
  // reporting a misleading "no installation found" state.
  if (user.is_owner !== 1) return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/app?reconnect=owner_required`, 303);
  try {
    const installations = await githubJson<Array<{ id: number; account?: { id?: number; login?: string; type?: string } }>>(
      'https://api.github.com/app/installations?per_page=100',
      { headers: githubHeaders(await appJwt(env)) }
    );
    const mine = (Array.isArray(installations) ? installations : []).filter(
      (installation) => String(installation.account?.id ?? '') === String(user.github_user_id)
    );
    let synced = 0;
    for (const installation of mine) {
      await syncInstallation(env, user, String(installation.id)).then(() => { synced += 1; }).catch((error) => {
        console.error('forge_reconnect_sync_failed', {
          installationId: installation.id,
          name: error instanceof Error ? error.name : 'unknown'
        });
      });
    }
    // Nothing found is a real answer, not a failure: the App genuinely is not
    // installed on this account, and the person needs to install it rather than
    // reconnect it.
    const outcome = mine.length === 0 ? 'none' : synced === 0 ? 'failed' : 'ok';
    return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/app?reconnect=${outcome}`, 303);
  } catch (error) {
    console.error('forge_reconnect_failed', { name: error instanceof Error ? error.name : 'unknown' });
    return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/app?reconnect=failed`, 303);
  }
}

export async function listAuthorizedRepositories(env: Env, tenantId: string): Promise<Array<Record<string, unknown>>> {
  const result = await env.METADATA.prepare(
    `SELECT owner, name, visibility, default_branch, installation_id, last_verified_at
       FROM repositories WHERE tenant_id = ?1 AND authorization_state = 'authorized' ORDER BY owner, name`
  ).bind(tenantId).all<Record<string, unknown>>();
  return result.results;
}

/**
 * Why a tenant has no usable repositories, when it has none.
 *
 * An empty list is not self-explaining, and the three reasons behind it need
 * completely different actions: never connected, connected then revoked, or
 * connected under a GitHub account that has since been renamed. Returning the
 * bare empty array left callers — and the people asking them — to guess, and the
 * guess is usually "Forge is broken" rather than "click install".
 */
export async function repositoryAccessDiagnosis(
  env: Env,
  tenantId: string
): Promise<{ state: 'ok' | 'never_installed' | 'revoked' | 'stale_owner'; detail: string; installUrl: string }> {
  const installUrl = `${env.FORGE_PUBLIC_ORIGIN}/github/install`;
  const installation = await env.METADATA.prepare(
    'SELECT status, account_login FROM github_installations WHERE tenant_id=?1 ORDER BY last_verified_at DESC LIMIT 1'
  ).bind(tenantId).first<{ status: string; account_login: string }>().catch(() => null);
  if (!installation) {
    return {
      state: 'never_installed',
      detail: 'The Forge GitHub App has not been installed for this account yet.',
      installUrl
    };
  }
  if (installation.status !== 'active') {
    return {
      state: 'revoked',
      detail: `The Forge GitHub App installation for ${installation.account_login} is no longer active — it was uninstalled, suspended, or replaced when the GitHub account changed. Reconnecting restores access to every repository.`,
      installUrl
    };
  }
  const user = await env.METADATA.prepare(
    'SELECT github_login FROM users WHERE tenant_id=?1 AND is_owner=1 LIMIT 1'
  ).bind(tenantId).first<{ github_login: string }>().catch(() => null);
  if (user && installation.account_login && user.github_login !== installation.account_login) {
    return {
      state: 'stale_owner',
      detail: `Repositories are still recorded under the old GitHub account name "${installation.account_login}" but the account is now "${user.github_login}". Reconnecting re-reads them under the current name.`,
      installUrl
    };
  }
  return { state: 'ok', detail: 'The GitHub App is installed but no repositories are authorized for it. Add repositories to the installation.', installUrl };
}





/**
 * Approve or decline someone waiting for access. Owner-only, and deliberately
 * cannot touch another owner's row — the gate is worth nothing if the people it
 * holds back can operate it.
 */
export async function resolveAccessRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const user = await getWebSession(request, env);
  if (!user) return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github`, 302);
  if (user.is_owner !== 1) return new Response('Only the owner can decide access.', { status: 403 });
  assertSameOrigin(request, env);
  const body = new URLSearchParams(await request.text());
  const target = body.get('user_id') ?? '';
  const decision = body.get('decision');
  if (!target || (decision !== 'approved' && decision !== 'denied')) {
    return new Response('Invalid decision', { status: 400 });
  }
  // This is a small private pilot, not a multi-tenant App marketplace. When
  // the owner approves somebody, move their Forge identity into the owner's
  // existing tenant/project. That gives the collaborator the repositories the
  // owner has explicitly installed without asking them to visit GitHub's
  // private-App URL (which GitHub correctly answers with a 404 for non-owners).
  // Their GitHub identity remains their own and every action stays audited to it.
  const ownerScope = decision === 'approved'
    ? await env.METADATA.prepare(
        'SELECT tenant_id, project_id FROM users WHERE id=?1 AND is_owner=1 LIMIT 1'
      ).bind(user.id).first<{ tenant_id: string; project_id: string }>()
    : null;
  if (decision === 'approved' && !ownerScope) {
    throw new ForgeError({
      code: 'FORGE_INTERNAL_ERROR',
      message: 'Forge could not resolve the owner project for this access request.',
      retryable: false
    });
  }
  await env.METADATA.prepare(
    `UPDATE users SET access_state=?1, access_resolved_at=?2, access_resolved_by=?3,
       tenant_id=CASE WHEN ?1='approved' THEN ?4 ELSE tenant_id END,
       project_id=CASE WHEN ?1='approved' THEN ?5 ELSE project_id END
      WHERE id=?6 AND is_owner=0`
  ).bind(
    decision,
    new Date().toISOString(),
    `github:${user.github_user_id}`,
    ownerScope?.tenant_id ?? '',
    ownerScope?.project_id ?? '',
    target
  ).run();
  return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/app`, 303);
}

/** True when this account may actually use Forge. Owners always may. */
export function hasForgeAccess(user: Pick<UserRow, 'access_state' | 'is_owner'> | null | undefined): boolean {
  if (!user) return false;
  return user.is_owner === 1 || (user.access_state ?? 'approved') === 'approved';
}

/** The page a signed-in account without access sees instead of the portal. */
function accessPendingPage(env: Env, user: UserRow, state: string): Response {
  const declined = state === 'denied';
  return page({
    title: `Forge — ${declined ? 'access declined' : 'access requested'}`,
    status: 403,
    topRight: '<a href="/logout">Sign out</a>',
    css: '.centre{max-width:34rem;margin:clamp(3rem,10vw,6rem) auto;text-align:center}',
    body: `<div class="centre"><h1>${declined ? 'Access declined' : 'Request received'}</h1>
<p>${declined
  ? 'Your request to use Forge was not approved. If you think that is a mistake, contact whoever runs this instance.'
  : `Thanks ${escapeHtml(user.github_login)} — your request is with the owner. You will be able to sign in here once it is approved.`}</p></div>`
  });
}

/**
 * GitHub intentionally hides private Apps from people who do not own them. Do
 * not turn that into an opaque 404: say exactly who installs the App and what
 * an approved collaborator should do next.
 */
function privateAppInstallHelpPage(env: Env): Response {
  return page({
    title: 'Forge — private GitHub connection',
    topRight: '<a href="/app">Back to Forge</a>',
    css: '.centre{max-width:42rem;margin:clamp(3rem,10vw,6rem) auto}.steps{padding-left:1.25rem}.steps li{margin:.75rem 0}',
    body: `<div class="centre"><h1>Your GitHub connection is managed by the Forge owner</h1>
<p>Forge is running a <strong>private</strong> GitHub App. GitHub intentionally returns a 404 when a collaborator opens a private App installation link, so there is nothing for you to install here.</p>
<ol class="steps"><li>The Forge owner installs the App on the repository and selects the repositories Forge may use.</li><li>The owner adds you as a GitHub collaborator for the repository.</li><li>You sign in to Forge and request access; after the owner approves it, the selected repositories appear in your Forge workspace.</li></ol>
<p>If your request is already approved but no repository appears, ask the owner to reconnect the GitHub App from their Forge dashboard.</p></div>`
  });
}

export async function appDashboard(request: Request, env: Env): Promise<Response> {
  const user = await getWebSession(request, env);
  if (!user) return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=${encodeURIComponent('/app')}`, 302);
  // Signing in is not the same as being allowed in.
  if (!hasForgeAccess(user)) return accessPendingPage(env, user, user.access_state ?? 'pending');
  const caps = workspaceCaps(env);
  const pendingAccessResult = user.is_owner === 1
    ? await env.METADATA.prepare(
        `SELECT id, github_login, avatar_url, access_requested_at FROM users
          WHERE access_state='pending' ORDER BY access_requested_at ASC LIMIT 25`
      ).all<{ id: string; github_login: string; avatar_url: string | null; access_requested_at: string | null }>()
        .then((result) => ({ ok: true as const, rows: result.results ?? [] }))
        .catch(() => ({ ok: false as const, rows: [] as Array<{ id: string; github_login: string; avatar_url: string | null; access_requested_at: string | null }> }))
    : { ok: true as const, rows: [] as Array<{ id: string; github_login: string; avatar_url: string | null; access_requested_at: string | null }> };
  const pendingAccess = pendingAccessResult.rows;
  const [repositories, occupants, awaitingReviewResult, pendingSyncResult] = await Promise.all([
    listAuthorizedRepositories(env, user.tenant_id),
    listSlotOccupants(env.METADATA, slotTtlMs(env), Date.now(), user.tenant_id).catch(() => []),
    listPendingDeferredActions(env, user.tenant_id)
      .then((rows) => ({ ok: true as const, rows }))
      .catch(() => ({ ok: false as const, rows: [] as DeferredAction[] })),
    listPendingSyncApprovals(env, user.tenant_id)
      .then((rows) => ({ ok: true as const, rows }))
      .catch(() => ({ ok: false as const, rows: [] as PendingSyncApproval[] }))
  ]);
  const awaitingReview = awaitingReviewResult.rows;
  const pendingSync = pendingSyncResult.rows;
  const reviewQueueFailed = !awaitingReviewResult.ok || !pendingSyncResult.ok;
  const usedSlots = occupants.length;
  const ttlMinutes = Math.round(slotTtlMs(env) / 60_000);
  const occupantRow = (occupant: (typeof occupants)[number]) => {
    const idle = occupant.idleMinutes === null ? '—' : `${occupant.idleMinutes}m idle`;
    const state = occupant.state ?? 'unknown';
    const flag = occupant.stale ? ' · reclaimable' : '';
    return `<li><span><strong>Slot ${occupant.slot}</strong><small>${escapeHtml(occupant.workspaceId.slice(0, 14))}… · ${escapeHtml(state)} · ${escapeHtml(idle)}${flag}</small></span></li>`;
  };
  const occupantRows = occupants.length
    ? `<ul class="list">${occupants.map(occupantRow).join('')}</ul>`
    : '';
  // When the list is empty, say why. "No repositories connected" reads as a
  // dead end; "your installation was revoked when the account was renamed" is
  // something the owner can act on in one click.
  const diagnosis = repositories.length === 0 ? await repositoryAccessDiagnosis(env, user.tenant_id).catch(() => null) : null;
  const repositoryRow = (repo: Record<string, unknown>) => `<li><span><strong>${escapeHtml(String(repo.owner))}/${escapeHtml(String(repo.name))}</strong><small>${escapeHtml(String(repo.visibility))} · ${escapeHtml(String(repo.default_branch))}</small></span></li>`;
  const rows = repositories.length
    ? repositories.slice(0, 6).map(repositoryRow).join('')
    : `<li><span><strong>No repositories connected</strong><small>${escapeHtml(diagnosis?.detail ?? 'Install the GitHub App to build, edit and create draft PRs.')}</small></span></li>`;
  const moreRows = repositories.length > 6
    ? `<details><summary>Show ${repositories.length - 6} more repositories</summary><ul class="list">${repositories.slice(6).map(repositoryRow).join('')}</ul></details>`
    : '';
  // The review queue: deferred submissions agents have staged, plus sync
  // approvals (shell / deploy / PR mutate / secret) that previously only lived
  // in the chat transcript — so the portal is the single place to find them.
  const reviewRow = (action: DeferredAction) => {
    const age = Math.max(0, Math.round((Date.now() - Date.parse(action.createdAt)) / 60000));
    const when = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.round(age / 60)}h ago` : `${Math.round(age / 1440)}d ago`;
    const status = action.state === 'failed'
      ? '<strong class="bad">needs another look</strong>'
      : action.state === 'executing' ? 'opening pull request…' : 'waiting for you';
    return `<li><span><strong>${escapeHtml(action.title)}</strong><small>${escapeHtml(action.repository.owner)}/${escapeHtml(action.repository.name)} · ${escapeHtml(action.branch)} → ${escapeHtml(action.base)} · ${action.filesChanged} file${action.filesChanged === 1 ? '' : 's'} · ${escapeHtml(when)} · ${status}</small></span><a class="btn" href="/approvals/${escapeHtml(action.approvalId)}">Review</a></li>`;
  };
  const syncLabel = (action: string) => {
    switch (action) {
      case 'shell.exec': return 'Shell command';
      case 'cloudflare.deploy': return 'Cloudflare deploy';
      case 'deploy.profile': return 'Deploy profile';
      case 'pull_request.mutate': return 'Pull request change';
      case 'pull_request.create': return 'Open pull request';
      case 'secret.attach': return 'Attach secret';
      default: return action;
    }
  };
  const syncRow = (approval: PendingSyncApproval) => {
    const remaining = Math.max(0, Math.round((Date.parse(approval.expiresAt) - Date.now()) / 60000));
    const when = remaining < 60 ? `${remaining}m left` : `${Math.round(remaining / 60)}h left`;
    return `<li><span><strong>${escapeHtml(syncLabel(approval.requestedAction))}</strong><small>${escapeHtml(approval.reason)} · ${escapeHtml(when)} · waiting for you</small></span><a class="btn" href="/approvals/${escapeHtml(approval.id)}">Review</a></li>`;
  };
  const reviewCount = awaitingReview.length + pendingSync.length;
  const reviewItems = [
    ...awaitingReview.map(reviewRow),
    ...pendingSync.map(syncRow)
  ].join('');
  const reviewSection = reviewQueueFailed
    ? `<section class="section alert"><h2>Waiting for your review</h2><p><strong>Could not load the review queue.</strong> Refresh in a moment — agents may still be waiting on approvals that are not listed here right now.</p></section>`
    : reviewCount
    ? `<section class="section alert"><h2>Waiting for your review <span class="badge">${reviewCount}</span></h2><p>Deferred submissions open the draft pull request when you approve — take your time. Sync approvals (shell, deploy, PR change, secret) unlock a live agent and expire in about two hours.</p><ul class="list">${reviewItems}</ul></section>`
    : '';
  const accessSection = pendingAccess.length
    ? `<section class="section alert"><h2>Access requests <span class="badge">${pendingAccess.length}</span></h2><p>These people signed in and are waiting for you. Until you approve them they cannot use Forge at all.</p><ul class="list">${
        pendingAccess.map((row) => `<li><span><strong>${escapeHtml(row.github_login)}</strong><small>asked ${escapeHtml(row.access_requested_at ? new Date(row.access_requested_at).toISOString().slice(0, 10) : 'recently')}</small></span><form class="row" method="post" action="${env.FORGE_PUBLIC_ORIGIN}/app/access"><input type="hidden" name="user_id" value="${escapeHtml(row.id)}"><button class="primary" name="decision" value="approved">Approve</button><button name="decision" value="denied">Decline</button></form></li>`).join('')
      }</ul></section>`
    : !pendingAccessResult.ok && user.is_owner === 1
      ? `<section class="section alert"><h2>Access requests</h2><p><strong>Could not load access requests.</strong> Refresh in a moment.</p></section>`
      : '';
  // Reconnect outcome, so the button visibly does something either way.
  const reconnectParam = new URL(request.url).searchParams.get('reconnect');
  const reconnectNote = reconnectParam === 'ok'
    ? '<p class="note"><strong>Reconnected.</strong> Repositories below are re-read from GitHub.</p>'
    : reconnectParam === 'none'
      ? '<p class="note"><strong>No installation found for your GitHub account.</strong> The Forge App is not installed — use Install below, not Reconnect.</p>'
      : reconnectParam === 'failed'
      ? '<p class="note"><strong>Reconnect failed.</strong> GitHub did not return a usable installation; try Install below.</p>'
      : reconnectParam === 'owner_required'
        ? '<p class="note"><strong>Your GitHub connection is owner-managed.</strong> The Forge owner installs and reconnects the private GitHub App; you do not need an installation link.</p>'
        : '';
  const mcpUrl = `${env.FORGE_PUBLIC_ORIGIN}/mcp`;
  const githubControls = user.is_owner === 1
    ? `<div class="row"><form method="post" action="${env.FORGE_PUBLIC_ORIGIN}/github/reconnect"><button class="${repositories.length === 0 ? 'primary' : ''}" type="submit">Reconnect GitHub</button></form>
<a class="btn" href="/github/install">Install or add repositories</a><a class="btn" href="/app/secrets">Secrets</a></div>
<details><summary>Invite a collaborator to this private Forge</summary><ol><li>Add their <strong>GitHub username</strong> as a repository collaborator in GitHub. An email address alone cannot identify a GitHub account until the invitation is accepted.</li><li>Have them sign in at Forge and choose <strong>Request access</strong>.</li><li>Approve their request above. Forge then shares this approved project and its installed repositories with their audited GitHub identity.</li></ol></details>`
    : `<p class="note"><strong>Private owner-managed connection.</strong> You do not install the GitHub App. Your owner selects repositories, adds you as a GitHub collaborator, then approves your Forge request.</p>`;
  const noRepositoryCopy = user.is_owner === 1
    ? 'Forge cannot open, build or change any repository until you reconnect the private GitHub App.'
    : 'No repository has been shared with you yet. Ask the Forge owner to add you as a GitHub collaborator, select the repository in the private App, and approve your access request.';
  return page({
    title: 'Forge — your workspace',
    topRight: `<span>${escapeHtml(user.github_login)}</span><a href="/logout">Sign out</a>`,
    css: `
.lead{margin:1.6rem 0 1.4rem}
.grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(min(100%,17rem),.65fr);gap:1.25rem;align-items:start}
.grid>*{min-width:0}
.slots{display:flex;gap:5px;margin:.6rem 0}
.slot{width:30px;height:8px;border-radius:4px;background:var(--bg);border:1px solid var(--line)}
.slot.used{background:var(--ink);border-color:var(--ink)}
.prompt{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:.75rem .85rem;margin-top:.5rem;font:.9rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
details{margin-top:.6rem}summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--muted);font-size:.88rem}summary:hover{color:var(--ink)}
@media(max-width:820px){.grid{grid-template-columns:1fr}}`,
    body: `<div class="lead"><h1>Your workspace</h1>
<p>Screenshot any site, change real code, and approve what comes back — from an ordinary ChatGPT or Claude conversation.</p></div>
${accessSection}${reviewSection}
<div class="grid"><div>
<section class="section"><h2>Start in your AI client</h2>
<p>Connect this MCP URL once, then use ordinary language. Forge picks the cheapest way to do what you ask.</p>
<code class="block" id="mcp">${escapeHtml(mcpUrl)}</code>
<button class="primary" type="button" onclick="navigator.clipboard.writeText(document.querySelector('#mcp').textContent);this.textContent='Copied'">Copy MCP URL</button></section>
<section class="section"><h2>Good first prompts</h2>
${dashboardFirstPrompts(user.github_login).map((prompt) => `<div class="prompt">${escapeHtml(prompt)}</div>`).join('')}
<p class="note">In ChatGPT or Claude you can also use Forge prompts: plan-work, iterate-ui, fix-bug, resume-task, start-task, review-live-url, prepare-draft-pr.</p></section>
</div><aside>
<section class="section"><h2>Workspace capacity</h2>
<p class="note"><a href="/app/live">Open live activity</a> — read-only view of running workspaces, MCP tools, and log tails.</p>
<div class="slots">${Array.from({ length: caps.perTenant }, (_, index) => `<i class="slot ${usedSlots > index ? 'used' : ''}"></i>`).join('')}</div>
<p class="note">${usedSlots} of ${caps.perTenant} active. Idle workspaces are reclaimed after ${ttlMinutes} minutes.</p>
${occupantRows}</section>
<section class="section${repositories.length === 0 ? ' alert' : ''}"><h2>GitHub repositories</h2>${reconnectNote}
${repositories.length === 0 ? `<p>${noRepositoryCopy}</p>` : ''}
${githubControls}
<ul class="list">${rows}</ul>${moreRows}</section>
</aside></div>
<footer>Forge — ${escapeHtml(env.FORGE_ENVIRONMENT)}</footer>`
  });
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
  // Provisioning already has an immutable, tenant/project-scoped workspace
  // binding. Read its installation row directly: authorizeRepository's public
  // API fallback adds a network dependency before the sandbox even exists and
  // can replace the real clone/setup failure with an unrelated API outage.
  const row = await env.METADATA.prepare(
    `SELECT installation_id
       FROM repositories
      WHERE tenant_id = ?1 AND project_id = ?2 AND owner = ?3 AND name = ?4
        AND authorization_state = 'authorized'`
  ).bind(
    workspace.tenantId,
    workspace.projectId,
    workspace.repository.owner,
    workspace.repository.name
  ).first<{ installation_id: string }>();
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

function bearer(request: Request): string {
  return request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
}

export async function gitCredentialProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/git\/(ws_[^/]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git\/(.+)$/u);
  if (!match) return new Response('Not found', { status: 404 });
  const [, workspaceId = '', owner = '', name = '', rest = ''] = match;
  const push = rest.includes('receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
  if (push) {
    throw new ForgeError({
      code: 'FORGE_GIT_PUSH_BLOCKED',
      message: 'Git receive-pack is disabled because forge_edit is the only repository writer. Use forge_edit to save code.',
      retryable: false
    });
  }
  const claims = await verifyCapability(bearer(request), env.FORGE_CAPABILITY_SIGNING_KEY, {
    workspaceId,
    action: 'git:clone',
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
  const token = await installationToken(env, repository.installation_id, repository.name, 'read');
  const upstream = new URL(`https://github.com/${owner}/${name}.git/${rest}`);
  upstream.search = url.search;
  const headers = new Headers(request.headers);
  headers.set('authorization', `Basic ${btoa(`x-access-token:${token}`)}`);
  headers.delete('cookie');
  headers.delete('host');
  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
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
  action: 'pull_request.create' | 'pull_request.mutate' | 'shell.exec' | 'work.submit' | 'secret.attach' | 'cloudflare.deploy' | 'deploy.profile',
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
  // Sync approvals need to survive a real build+push cycle (default 120 min).
  // Deferred work.submit is decided from the portal minutes or days later, so
  // it gets a much longer window — otherwise the queue fills with expired rows
  // the human can see but cannot approve.
  const ttlRaw = action === 'work.submit'
    ? Number(env.FORGE_DEFERRED_APPROVAL_TTL_MINUTES)
    : Number(env.FORGE_APPROVAL_TTL_MINUTES);
  const fallback = action === 'work.submit' ? DEFERRED_APPROVAL_TTL_MINUTES : 120;
  const minutes = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : fallback;
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
  action: 'pull_request.create' | 'pull_request.mutate' | 'shell.exec' | 'work.submit' | 'secret.attach' | 'cloudflare.deploy' | 'deploy.profile',
  expected: Record<string, unknown>,
  options: { consume?: boolean } = {}
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
    throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: row.state === 'pending' ? 'Approval is still pending. Echo the approval_url to the human and stop — do not poll forge_pr or forge_merge. Retry once only after they confirm approval, with the same approval_id and idempotency_key.' : 'This approval was already used. Request a fresh approval_id and retry the same forge_* tool — do not reuse the spent id.', retryable: false });
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
      message: `The operation changed since it was approved: ${changed.map((c) => `${c.field} was ${String(c.approved)}, is now ${String(c.current)}`).join('; ')}. Re-check the outgoing change with forge_diff_metadata and request a fresh approval.`,
      retryable: false,
      details: { changed }
    });
  }
  if (options.consume === false) return;
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
 * External writes stay strictly one-approval-one-
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
function approvalIsReusable(action: string): boolean {
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
export function renderDiffHtml(diff: string): string {
  // Budgets, and why there are two. A single overall cap let the first big file
  // eat the entire allowance, so every file after it rendered ZERO rows while
  // the page said only "N more lines truncated" — the reviewer could not see
  // that later files existed at all. A per-file cap keeps every file
  // represented; the overall cap still bounds the page.
  const MAX_ROWS = 4_000;
  const MAX_ROWS_PER_FILE = 400;
  const files = parseDiff(diff);
  let budget = MAX_ROWS;
  let hiddenRows = 0;
  let hiddenFiles = 0;

  const cards = files.map((file) => {
    const head = `<header class="dfhead"><span class="dfico" aria-hidden="true">${fileGlyph(file.path)}</span><span class="dfpath">${escapeHtml(file.path)}</span><span class="dfstat"><span class="s-add">+${file.added}</span><span class="s-del">−${file.removed}</span></span></header>`;
    // Out of budget: still show the file's header. Knowing a file changed
    // matters more to the decision than seeing its hunks.
    if (budget <= 0 && !file.binary) {
      hiddenFiles += 1;
      hiddenRows += file.rows.length;
      return `<section class="dfile">${head}<div class="dfbody"><div class="drow ctx">Not shown — the page is already at its display limit.</div></div></section>`;
    }
    const limit = Math.min(MAX_ROWS_PER_FILE, budget);
    const rows = file.rows.slice(0, limit);
    const cut = file.rows.length - rows.length;
    hiddenRows += cut;
    budget -= rows.length;
    // One element per row, with the two line-number gutters drawn from data
    // attributes in CSS. The previous markup spent a div plus four spans on
    // every line: 4,000 lines became ~20,000 nodes and ~660 KB of HTML, which
    // is what made this page slow to open on a phone.
    const body = file.binary
      ? '<div class="drow ctx">Binary file not shown</div>'
      : rows.map((row) => {
          const sign = row.type === 'add' ? '+' : row.type === 'del' ? '−' : row.type === 'hunk' ? '' : ' ';
          const oldNo = row.oldNo === null ? '' : String(row.oldNo);
          const newNo = row.newNo === null ? '' : String(row.newNo);
          return `<div class="drow ${row.type}" data-o="${oldNo}" data-n="${newNo}">${sign}${escapeHtml(row.text) || ' '}</div>`;
        }).join('')
        + (cut > 0 ? `<div class="drow ctx">… ${cut} more line${cut === 1 ? '' : 's'} in this file</div>` : '');
    return `<section class="dfile">${head}<div class="dfbody">${body}</div></section>`;
  }).join('');

  const notes: string[] = [];
  if (hiddenRows > 0) notes.push(`${hiddenRows} line${hiddenRows === 1 ? '' : 's'} not shown`);
  if (hiddenFiles > 0) notes.push(`${hiddenFiles} file${hiddenFiles === 1 ? '' : 's'} listed without their changes`);
  const trailer = notes.length
    ? `<p class="dtrunc">${notes.join(', ')} — this page shows a bounded preview. Review the full diff in the workspace before approving.</p>`
    : '';
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

/**
 * Resolve who is looking at an approval: either a signed link (approve straight
 * from the transcript, no re-login) or a logged-in web session. Shared by the
 * approval page and its preview endpoint so both authenticate identically.
 */
async function approvalViewer(
  request: Request,
  env: Env,
  approvalId: string
): Promise<{ tenantId: string; resolvedBy: string; token: string } | null> {
  const token = new URL(request.url).searchParams.get('t') ?? '';
  const linkClaims = token ? await verifyApprovalLink(env, token, approvalId) : null;
  const user = linkClaims ? null : await getWebSession(request, env);
  const tenantId = linkClaims?.tenant ?? user?.tenant_id ?? null;
  if (!tenantId) return null;
  return { tenantId, resolvedBy: user ? `github:${user.github_user_id}` : 'approval-link', token };
}

/**
 * Launch (POST) and poll (GET) the on-demand review preview for a submission.
 *
 * Provisioning a container takes far longer than a request should, so the page
 * kicks it off and then polls this endpoint until it reports ready. When it does,
 * the signed preview capability is handed to the browser as a path-scoped
 * HttpOnly cookie — the preview proxy accepts it there because a navigation
 * cannot carry the header an agent would use.
 */
export async function approvalPreviewEndpoint(
  request: Request,
  env: Env,
  approvalId: string
): Promise<Response> {
  const viewer = await approvalViewer(request, env, approvalId);
  if (!viewer) {
    return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=${encodeURIComponent(request.url)}`, 302);
  }
  const action = await getDeferredActionByApproval(env, viewer.tenantId, approvalId);
  if (!action) return new Response('Not found', { status: 404 });

  const stub = (innerEnv: Env, workspaceId: string) =>
    innerEnv.WORKSPACE_COORDINATORS.get(innerEnv.WORKSPACE_COORDINATORS.idFromName(workspaceId)) as unknown as never;

  if (request.method === 'POST') {
    assertSameOrigin(request, env);
    await launchReviewPreview(env, action, stub);
    const back = `${env.FORGE_PUBLIC_ORIGIN}/approvals/${approvalId}${viewer.token ? `?t=${encodeURIComponent(viewer.token)}` : ''}`;
    return Response.redirect(back, 303);
  }

  const status = await reviewPreviewStatus(env, action, stub);
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  if (status.state === 'ready' && status.capability && status.previewPath) {
    const maxAge = status.expiresAt
      ? Math.max(60, Math.floor((Date.parse(status.expiresAt) - Date.now()) / 1000))
      : 3600;
    headers.append(
      'set-cookie',
      `forge_preview_${status.previewPath.split('/')[3]}=${encodeURIComponent(status.capability)}; Path=${status.previewPath}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
    );
  }
  // The capability is delivered only as a cookie; never echo it into JSON the
  // page could accidentally render or log.
  const { capability, previewPath, ...safe } = status;
  return new Response(JSON.stringify(safe), { headers });
}

/** Status banner for a deferred submission, shown above the diff. */
function renderDeferredOutcome(action: DeferredAction): string {
  const target = `${escapeHtml(action.branch)} → ${escapeHtml(action.base)}`;
  if (action.state === 'completed' && action.result) {
    return `<div class="outcome ok"><strong>Merged into the queue.</strong> Forge pushed ${target} and opened <a href="${escapeHtml(action.result.pr_url)}">draft pull request #${action.result.pr_number}</a>.</div>`;
  }
  if (action.state === 'failed') {
    return `<div class="outcome bad"><strong>Could not complete this submission.</strong> ${escapeHtml(action.error ?? 'Unknown error.')} The commits are safe on <code>${escapeHtml(action.stagedRef)}</code>; approving again retries.</div>`;
  }
  if (action.state === 'denied') {
    return `<div class="outcome bad"><strong>Declined.</strong> Nothing was pushed. The commits remain on <code>${escapeHtml(action.stagedRef)}</code>.</div>`;
  }
  return `<div class="outcome"><strong>Waiting on you — no rush.</strong> ${escapeHtml(String(action.filesChanged))} file${action.filesChanged === 1 ? '' : 's'} changed, staged on <code>${escapeHtml(action.stagedRef)}</code>. Approving pushes ${target} and opens a draft pull request. The agent has already finished; nothing is blocked on this.</div>`;
}

/**
 * A readable page for a decision that could not be recorded.
 *
 * `reason` is echoed in a meta tag as well as the prose so a failure can be
 * identified exactly — from a screenshot, or with a single curl — instead of
 * being reported as "it errors".
 */
function decisionProblem(env: Env, status: number, reason: string, heading: string, detail: string): Response {
  return page({
    status,
    title: `Forge — ${heading}`,
    topRight: '<a href="/app">Portal</a>',
    body: `<meta name="forge-reason" content="${escapeHtmlLocal(reason)}">
<h1>${heading}</h1>
<div class="section alert"><p>${detail}</p></div>
<p class="note">Nothing was pushed and nothing was changed by this attempt.</p>`
  });
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
  // Stay on FORGE_PUBLIC_ORIGIN for the approval URL / form action.
  const self = forgeOrigin(request, env);
  if (!tenantId) return Response.redirect(`${self}/login/github?return_to=${encodeURIComponent(request.url)}`, 302);
  const resolvedBy = user ? `github:${user.github_user_id}` : 'approval-link';
  // Preserve the signed token across the POST → 303 → GET round-trip so the
  // reviewer never bounces to login mid-decision.
  const selfUrl = `${self}/approvals/${approvalId}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
  const row = await env.METADATA.prepare(
    'SELECT requested_action, reason, request_payload, state, expires_at, workspace_id FROM approvals WHERE id=?1 AND tenant_id=?2'
  ).bind(approvalId, tenantId).first<{ requested_action: string; reason: string; request_payload: string; state: string; expires_at: string; workspace_id: string }>();
  if (!row) return decisionProblem(env, 404, 'not_found', 'Approval not found', 'This approval no longer exists, or it belongs to a different account.');
  // Deferred submissions are meant to be decided hours or days later. The
  // linked approvals row still carries an expires_at (used for signed links and
  // sync redemption), but a still-queued deferred action must remain decidable
  // from the portal — otherwise the dashboard shows an item nobody can approve.
  const deferredForGate = await getDeferredActionByApproval(env, tenantId, approvalId).catch(() => null);
  const deferredStillOpen = Boolean(
    deferredForGate && (deferredForGate.state === 'awaiting_approval' || deferredForGate.state === 'failed')
  );
  // After a failed promote/PR step the approval is already 'approved' but the
  // deferred row is 'failed'. The page used to claim "approving again retries"
  // while refusing every POST — leave a real retry path.
  const deferredRetryable = Boolean(
    deferredForGate && deferredForGate.state === 'failed' && (row.state === 'approved' || row.state === 'pending')
  );
  if (request.method === 'POST') {
    // Every refusal below renders a real page naming the cause. These used to
    // return bare one-line text — a reviewer pressing Approve got an unstyled
    // "Approval expired" or a raw 403 with nothing saying what to do, and no
    // way to tell the failures apart when reporting them.
    // CSRF is an AMBIENT-CREDENTIALS attack: it matters when the browser
    // attaches the session cookie by itself, so a forged cross-site form can
    // act as the victim. A signed approval link carries its own unguessable,
    // server-signed authorization in the URL instead — anyone able to make a
    // victim's browser submit it would have to already hold the link, and could
    // just open it themselves. So the Origin check guards the cookie-session
    // path only.
    //
    // Requiring a recognisable Origin on the link flow broke real reviewers: a
    // sandboxed webview or iframe — which is every in-app browser, including
    // the one a chat client opens links in — posts `Origin: null`. That matches
    // no hostname, so no allow-list can ever admit it, and it is not forgeable
    // into one either. The reviewer just saw the decision rejected every time.
    if (!linkClaims) {
      try {
        assertSameOrigin(request, env);
      } catch {
        return decisionProblem(
          env, 403, 'cross_origin', 'Could not submit that decision',
          `This page was opened from ${escapeHtmlLocal(request.headers.get('origin') ?? 'an unrecognised address')}, which is not an address Forge serves. Open the approval link again and press the button on the freshly loaded page.`
        );
      }
    }
    const body = new URLSearchParams(await request.text());
    const decision = body.get('decision');
    if (decision !== 'approved' && decision !== 'denied') {
      return decisionProblem(
        env, 400, 'invalid_decision', 'Could not read that decision',
        'The form did not send a recognisable Approve or Deny. Reload the approval page and press the button again.'
      );
    }
    const retryFailedDeferred = decision === 'approved' && deferredRetryable;
    const denyFailedDeferred = decision === 'denied' && deferredForGate?.state === 'failed';
    if (row.state !== 'pending' && !retryFailedDeferred && !denyFailedDeferred) {
      return decisionProblem(
        env, 409, 'already_resolved', `Already ${escapeHtmlLocal(row.state)}`,
        `Someone already resolved this approval, so nothing further was done. Reload the page to see the outcome.`
      );
    }
    if (row.state === 'pending' && Date.parse(row.expires_at) <= Date.now() && !deferredStillOpen) {
      return decisionProblem(
        env, 409, 'expired', 'This approval has expired',
        'Nothing was done. Approvals are deliberately short-lived; ask the agent to request this action again and a fresh link will be issued.'
      );
    }
    if (row.state === 'pending') {
      await env.METADATA.prepare('UPDATE approvals SET state=?1, resolved_by=?2, resolved_at=?3 WHERE id=?4 AND state=\'pending\'')
        .bind(decision, resolvedBy, new Date().toISOString(), approvalId).run();
    }
    // A deferred submission has no agent waiting to redeem this approval — the
    // whole point is that the agent left hours ago. Forge does the work itself,
    // here, the moment the human decides. Failed rows are claimed again by
    // executeDeferredAction (state IN awaiting_approval, failed).
    const deferred = deferredForGate;
    if (deferred) {
      if (decision === 'approved') {
        const executed = await executeDeferredAction(env, deferred, { promoteStagedRef, createDraftPullRequest }).catch((error) => {
          console.error('forge_deferred_execute_failed', {
            deferredId: deferred.id,
            name: error instanceof Error ? error.name : 'unknown'
          });
          return null;
        });
        if (!executed || executed.state === 'failed') {
          // Leave the approval as approved so "Retry" still works; mark the
          // deferred row failed if execute threw before it could.
          if (!executed) {
            await env.METADATA.prepare(
              "UPDATE deferred_actions SET state='failed', error=?1, updated_at=?2 WHERE id=?3 AND state IN ('awaiting_approval','executing')"
            ).bind(
              'Could not open the pull request. Approve again to retry.',
              new Date().toISOString(),
              deferred.id
            ).run().catch(() => undefined);
          }
        } else {
          await releaseReviewPreview(env, deferred.id, async (workspaceId) => {
            const destroyId = workflowInstanceId('destroy', workspaceId as WorkspaceId);
            const stub = env.WORKSPACE_COORDINATORS.get(env.WORKSPACE_COORDINATORS.idFromName(workspaceId)) as unknown as {
              requestDestroy: (input: { idempotencyKey: string; force: boolean }) => Promise<unknown>;
            };
            await stub.requestDestroy({ idempotencyKey: `review-preview-${destroyId}`, force: true });
            await env.DESTROY_WORKFLOW.create({
              id: destroyId,
              params: { workspaceId: workspaceId as WorkspaceId, idempotencyKey: `review-preview-${destroyId}`, preserveArtifacts: false, force: true }
            });
          });
        }
      } else {
        await denyDeferredAction(env, deferred.id).catch(() => undefined);
        await releaseReviewPreview(env, deferred.id, async (workspaceId) => {
          const destroyId = workflowInstanceId('destroy', workspaceId as WorkspaceId);
          const stub = env.WORKSPACE_COORDINATORS.get(env.WORKSPACE_COORDINATORS.idFromName(workspaceId)) as unknown as {
            requestDestroy: (input: { idempotencyKey: string; force: boolean }) => Promise<unknown>;
          };
          await stub.requestDestroy({ idempotencyKey: `review-preview-${destroyId}`, force: true });
          await env.DESTROY_WORKFLOW.create({
            id: destroyId,
            params: { workspaceId: workspaceId as WorkspaceId, idempotencyKey: `review-preview-${destroyId}`, preserveArtifacts: false, force: true }
          });
        });
      }
    }
    return Response.redirect(selfUrl, 303);
  }
  const payload = JSON.parse(row.request_payload) as Record<string, unknown>;
  // Pull out the display-only diff/body; show the rest as a small key/value
  // list so the human approves what they can actually read, not a raw hash blob.
  const { diff: inlineDiff, body, diffTotals, diffArtifactId, ...meta } = payload as {
    diff?: string;
    body?: string;
    diffArtifactId?: string;
    // True scale of the change, independent of how much diff text was attached.
    // A large diff is attached one page of files at a time, so counting the
    // rendered text would under-report what is actually being approved.
    diffTotals?: { files?: number; additions?: number; deletions?: number };
    [key: string]: unknown;
  };
  let diff = typeof inlineDiff === 'string' ? inlineDiff : '';
  if ((!diff.trim()) && typeof diffArtifactId === 'string' && diffArtifactId.startsWith('art_') && row.workspace_id) {
    try {
      const object = await new R2ArtifactStore(env.ARTIFACTS).get(
        tenantId as TenantId,
        row.workspace_id as WorkspaceId,
        diffArtifactId as ArtifactId
      );
      if (object) diff = await object.text();
    } catch {
      diff = '';
    }
  }
  const metaRows = Object.entries(meta)
    .filter(([, value]) => value !== '' && value !== undefined && value !== null)
    .map(([key, value]) => `<div class="kv"><span>${escapeHtml(key)}</span><code>${escapeHtml(String(value))}</code></div>`)
    .join('');
  // For a deferred submission the page is also the receipt: after approving,
  // the reviewer should land back here and see the pull request Forge opened —
  // or exactly why it could not.
  const deferredAction = deferredForGate;
  const outcomeBlock = deferredAction ? renderDeferredOutcome(deferredAction) : '';
  // On-demand live preview. Provisioning takes far longer than a request, so the
  // button only kicks it off and the page polls until there is a URL to open.
  const previewBlock = deferredAction && deferredAction.state === 'awaiting_approval'
    ? `<div class="preview" id="pv" data-endpoint="${escapeHtml(`${env.FORGE_PUBLIC_ORIGIN}/approvals/${approvalId}/preview${token ? `?t=${encodeURIComponent(token)}` : ''}`)}">
<div class="pvhead"><strong>See it running</strong><span class="pvstatus" id="pvs">Not started</span></div>
<p class="pvnote">Builds a throwaway workspace from the staged commit and starts the dev server, so you can click through the change before approving. Takes a minute or so, and is cleaned up automatically.</p>
<form method="post" action="${escapeHtml(`${env.FORGE_PUBLIC_ORIGIN}/approvals/${approvalId}/preview${token ? `?t=${encodeURIComponent(token)}` : ''}`)}" id="pvf"><button type="submit">Launch preview</button></form>
<a class="pvlink" id="pvl" href="#" target="_blank" rel="noopener" hidden>Open preview →</a></div>
<script>(function(){var b=document.getElementById('pv');if(!b)return;var s=document.getElementById('pvs'),l=document.getElementById('pvl'),f=document.getElementById('pvf');
var labels={none:'Not started',provisioning:'Building workspace…',starting:'Starting dev server…',ready:'Ready',failed:'Failed'};
function poll(){fetch(b.dataset.endpoint,{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(d){
s.textContent=d.state==='failed'&&d.error?d.error:(labels[d.state]||d.state);
if(d.state==='ready'&&d.url){l.href=d.url;l.hidden=false;f.hidden=true;return}
if(d.state==='failed'){f.hidden=false;return}
if(d.state==='provisioning'||d.state==='starting'){f.hidden=true;setTimeout(poll,4000)}
}).catch(function(){setTimeout(poll,8000)})}
poll();})();</script>`
    : '';
  // The POST path refuses an expired sync approval, so the page must not offer
  // a button that can only fail. Deferred submissions stay decidable while the
  // queue row is still open — their expires_at is not the human deadline. Failed
  // deferred rows stay retryable even after the approval flipped to 'approved'.
  const expired = row.state === 'pending' && Date.parse(row.expires_at) <= Date.now() && !deferredStillOpen;
  const decidable = (row.state === 'pending' && !expired) || deferredRetryable;
  const expiredBlock = expired
    ? '<div class="outcome bad"><strong>This approval has expired.</strong> Nothing was done. Ask the agent to request it again — a fresh approval takes seconds and this link cannot be revived.</div>'
    : '';
  // A deferred submission is performed by Forge itself on approval. Everything
  // else only RECORDS the decision — the agent that asked still has to come
  // back and redeem it. If that session has ended, approving here is correct
  // but nothing visible happens, which reads as a silent failure unless said.
  const handoffBlock = decidable && !deferredAction
    ? '<p class="note">Approving records your decision so the agent that asked can carry it out. It does not perform the action from this page — if that session has already ended, ask it again and it will go straight through.</p>'
    : '';
  const hasDiff = typeof diff === 'string' && diff.trim() !== '';
  const shown = hasDiff ? diffStats(diff) : null;
  // Headline figures come only from recorded totals — never by counting attached
  // diff text, which may be a truncated page of a larger change.
  const stats = diffTotals?.files !== undefined
    ? { files: diffTotals.files, added: diffTotals.additions ?? 0, removed: diffTotals.deletions ?? 0 }
    : null;
  const statsLine = stats
    ? `<p class="stats"><b>${stats.files}</b> file${stats.files === 1 ? '' : 's'} · <span class="s-add">+${stats.added}</span> <span class="s-del">−${stats.removed}</span></p>`
    : '';
  // Never let the reviewer believe they have seen the whole change when the
  // attached diff stops short.
  const partialLine = stats && shown && shown.files < stats.files
    ? `<p class="note">Showing the diff for ${shown.files} of ${stats.files} files — the rest is too large to render here. The approval covers the entire change.</p>`
    : '';
  const bodyBlock = typeof body === 'string' && body.trim() !== '' ? `<pre class="body">${escapeHtml(body)}</pre>` : '';
  const contentBlock = hasDiff
    ? renderDiffHtml(diff)
    : metaRows === ''
      ? `<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`
      : '';
  const approveLabel = deferredRetryable
    ? 'Retry opening pull request'
    : deferredAction
      ? 'Approve &amp; open pull request'
      : 'Approve once';
  return page({
    title: `Forge — ${decidable ? (deferredRetryable ? 'retry' : 'approve') : expired ? 'expired' : row.state}`,
    topRight: '<a href="/app">Portal</a>',
    css: `
.stats{color:var(--ink);font-weight:600;margin:.9rem 0}
.s-add{color:var(--ok)}.s-del{color:var(--bad)}
.outcome{margin:1rem 0;padding:.9rem 1.1rem;border:1px solid var(--line);border-left:3px solid var(--ink);border-radius:12px;background:var(--panel);font-size:.94rem}
.outcome a{font-weight:600}.outcome.ok{border-left-color:var(--ok)}.outcome.bad{border-left-color:var(--bad)}
.preview{margin:1rem 0;padding:.9rem 1.1rem;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.pvhead{display:flex;align-items:center;gap:.75rem;justify-content:space-between}
.pvstatus{color:var(--muted);font-size:.85rem}.pvnote{margin:.45rem 0 .8rem;font-size:.88rem}
.preview form{margin:0}.pvlink[hidden],.preview form[hidden]{display:none}
.pvlink{display:inline-flex;align-items:center;min-height:44px;padding:.55rem 1.05rem;border-radius:10px;background:var(--ink);color:var(--bg);text-decoration:none;font-weight:600}
pre.body{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:1rem;white-space:pre-wrap;overflow-wrap:anywhere;max-height:16rem;overflow:auto;font:.85rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.diffset{margin-top:1.25rem;display:flex;flex-direction:column;gap:1rem}
/* content-visibility lets the browser skip layout and paint for the file cards
   that are off-screen, which is most of them on a long diff. contain-intrinsic-size
   supplies a placeholder height so the scrollbar does not jump as they render. */
.dfile{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel);content-visibility:auto;contain-intrinsic-size:auto 22rem}
.dfhead{display:flex;align-items:center;gap:.6rem;padding:.6rem .9rem;background:var(--bg);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:1}
.dfico{font-size:.7rem;font-weight:700;color:var(--muted);min-width:1.6rem;text-align:center}
.dfpath{font:600 .82rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfstat{margin-left:auto;display:flex;gap:.5rem;font:700 .74rem/1 ui-monospace,monospace;flex:0 0 auto}
.dfbody{max-height:30rem;overflow:auto;font:.8rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
/* Each row is a single element; the old/new line numbers come from its data
   attributes via ::before/::after rather than from two extra spans per line. */
.drow{position:relative;padding:0 .75rem 0 6.9rem;white-space:pre;min-width:0}
.drow::before,.drow::after{position:absolute;top:0;width:3rem;padding:0 .45rem;text-align:right;color:var(--muted);opacity:.6;user-select:none;white-space:nowrap;box-sizing:border-box}
.drow::before{content:attr(data-o);left:0}
.drow::after{content:attr(data-n);left:3rem;border-right:1px solid var(--line)}
.drow.add{background:var(--ok-bg);color:var(--ok)}
.drow.del{background:var(--bad-bg);color:var(--bad)}
.drow.hunk{background:var(--bg);color:var(--muted);font-weight:600}
.drow.ctx{color:var(--muted)}
.dtrunc{font-size:.85rem;margin-top:.25rem}
form.decide{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.5rem;position:sticky;bottom:0;z-index:2;background:var(--bg);border-top:1px solid var(--line);padding:.85rem 0 1rem}
body{padding-bottom:5rem}
@media(max-width:560px){form.decide{flex-direction:column}form.decide button{width:100%}}`,
    body: `<h1>${decidable ? (deferredRetryable ? 'Retry Forge submission' : 'Approve Forge action') : expired ? 'Approval expired' : `Action ${escapeHtml(row.state)}`}</h1>
<p><strong>${escapeHtml(row.requested_action)}</strong> — ${escapeHtml(row.reason)}</p>
${expiredBlock}${outcomeBlock}${previewBlock}${statsLine}${partialLine}${handoffBlock}${metaRows ? `<div class="meta">${metaRows}</div>` : ''}${bodyBlock}${contentBlock}
${decidable ? `<form class="decide" method="post" action="${escapeHtml(selfUrl)}"><button class="primary" name="decision" value="approved">${approveLabel}</button><button name="decision" value="denied">Deny</button></form>` : ''}`
  });
}

/**
 * Point `refs/heads/<branch>` at an already-staged commit, server-side.
 *
 * This is the push half of an approved deferred submission. It runs entirely
 * against the GitHub REST API with the installation token, which is the whole
 * reason approval can be asynchronous: the workspace that produced the commit is
 * usually long gone by the time the human clicks approve, and nothing here needs
 * it. The commit is already in the repository (the agent staged it to a
 * `forge/staged/…` ref at submit time), so this only moves a ref.
 *
 * Creates the branch when absent, fast-forwards it when present. `force` is
 * deliberately false: if the branch has moved on independently since the agent
 * staged its work, GitHub rejects the update and the reviewer is told, rather
 * than Forge silently overwriting someone else's commits.
 */
export async function promoteStagedRef(
  env: Env,
  identity: Pick<AuthenticatedContext, 'tenantId' | 'projectId'>,
  repository: RepositoryRef,
  input: { branch: string; commitSha: string }
): Promise<void> {
  assertAllowedForgeBranch(input.branch, 'main');
  const row = await authorizeRepository(env, identity, repository);
  if (!row) throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'GitHub App authorization is required.', retryable: false });
  const token = await installationToken(env, row.installation_id, repository.name, 'write');
  const base = `https://api.github.com/repos/${repository.owner}/${repository.name}/git/refs`;
  const existing = await fetch(`${base}/heads/${encodeURIComponent(input.branch)}`, { headers: githubHeaders(token) });
  if (existing.status === 404) {
    await githubJson(base, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: input.commitSha })
    });
    return;
  }
  if (!existing.ok) {
    throw new ForgeError({
      code: 'FORGE_GIT_PUSH_BLOCKED',
      message: `Could not read the target branch (HTTP ${existing.status}).`,
      retryable: true
    });
  }
  const update = await fetch(`${base}/heads/${encodeURIComponent(input.branch)}`, {
    method: 'PATCH',
    headers: githubHeaders(token),
    body: JSON.stringify({ sha: input.commitSha, force: false })
  });
  if (!update.ok) {
    const detail = await update.text().catch(() => '');
    throw new ForgeError({
      code: 'FORGE_STALE_REVISION',
      message: update.status === 422
        ? `${input.branch} has moved on since this work was staged, so it can no longer be fast-forwarded. Rebase the staged commit and submit again.`
        : `Could not update ${input.branch} (HTTP ${update.status}). ${detail.slice(0, 200)}`,
      retryable: false
    });
  }
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
  const action = String(payload.action ?? '');
  if (installation?.id && (event === 'installation' || event === 'installation_repositories')) {
    if (['deleted', 'suspend', 'suspended'].includes(action)) {
      await env.METADATA.batch([
        env.METADATA.prepare("UPDATE github_installations SET status='revoked', last_verified_at=?1 WHERE installation_id=?2")
          .bind(new Date().toISOString(), String(installation.id)),
        env.METADATA.prepare("UPDATE repositories SET authorization_state='revoked', last_verified_at=?1 WHERE installation_id=?2")
          .bind(new Date().toISOString(), String(installation.id))
      ]);
      return new Response(null, { status: 204 });
    }
  }
  // Anything that can move a repository's owner or name invalidates the stored
  // slug, which is what the rest of Forge looks repositories up by. Re-sync from
  // GitHub rather than trying to patch the row from the payload, so one code
  // path owns what "authorized repositories" means.
  const RESYNC_ACTIONS = new Set(['renamed', 'transferred', 'added', 'removed', 'created', 'unsuspend', 'unsuspended', 'new_permissions_accepted']);
  if (installation?.id && (RESYNC_ACTIONS.has(action) || event === 'repository')) {
    const owner = await env.METADATA.prepare(
      `SELECT u.id, u.github_user_id, u.github_login, u.avatar_url, u.tenant_id, u.project_id, u.access_state, u.is_owner
         FROM github_installations i JOIN users u ON u.tenant_id = i.tenant_id
        WHERE i.installation_id = ?1 LIMIT 1`
    ).bind(String(installation.id)).first<UserRow>().catch(() => null);
    if (owner) {
      await syncInstallation(env, owner, String(installation.id)).catch((error) => {
        console.error('forge_webhook_resync_failed', {
          event,
          action,
          name: error instanceof Error ? error.name : 'unknown'
        });
      });
    }
  }
  return new Response(null, { status: 204 });
}

/**
 * An authenticated GitHub REST caller scoped to a workspace's repository.
 *
 * This is what makes an edit remote-first: the agent's write becomes a commit
 * on origin through this transport, so there is never a window where the work
 * exists only inside a container.
 */
export async function githubRequestForWorkspace(
  env: Env,
  identity: Pick<AuthenticatedContext, 'tenantId' | 'projectId'>,
  workspace: Pick<Workspace, 'repository'>
): Promise<GitHubRequest> {
  const row = await authorizeRepository(env, identity, workspace.repository);
  if (!row) {
    throw new ForgeError({
      code: 'FORGE_PERMISSION_DENIED',
      message: 'Install and authorize the Forge GitHub App for this repository before editing.',
      retryable: false
    });
  }
  const token = await installationToken(env, row.installation_id, workspace.repository.name, 'write');
  return async (path, init) => {
    const headers = githubHeaders(token);
    if (init?.body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(`https://api.github.com${path}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body)
    });
    const text = await response.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return { status: response.status, json };
  };
}
