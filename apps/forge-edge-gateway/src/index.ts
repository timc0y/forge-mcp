import { getSandbox, Sandbox, ContainerProxy } from '@cloudflare/sandbox';
import { ForgeError, type WorkspaceId } from '@forge/core';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import { listSlotOccupants, reclaimStaleSlots, releaseWorkspaceSlot, slotTtlMs } from './capacity';
import { snapshotsEnabled, snapshotKey, recordSnapshot } from './snapshots';
import { handleMultipartUpload } from './multipart-upload';
import { parseDepsCacheKey, recordDepsCache } from './deps-cache';
import { verifyCapability } from '@forge/capabilities';
import openapi from '../../../openapi/forge.openapi.json';
import { ForgeMcpSession } from './mcp-session';
import { WorkspaceCoordinator } from './workspace-coordinator';
import { ProvisionWorkspaceWorkflow, DestroyWorkspaceWorkflow } from './workflows';
import { authenticate, constantTimeEqual, oauthChallenge } from './auth';
import {
  authorizationServerMetadata,
  authorize,
  registerClient,
  token
} from './oauth';
import type { Env } from './env';
import {
  appDashboard,
  approvalPage,
  finishGitHubInstall,
  finishGitHubLogin,
  githubWebhook,
  gitCredentialProxy,
  installGitHubApp,
  logout,
  startGitHubLogin
} from './github';

export {
  Sandbox,
  ContainerProxy,
  ForgeMcpSession,
  WorkspaceCoordinator,
  ProvisionWorkspaceWorkflow,
  DestroyWorkspaceWorkflow
};

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('cache-control', 'no-store');
  return Response.json(body, { status, headers: responseHeaders });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'public, max-age=300',
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    }
  });
}

function favicon(): Response {
  return new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5b4cf0"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><text x="32" y="33" font-size="34" text-anchor="middle" dominant-baseline="central" fill="#fff" font-family="system-ui,sans-serif">⚒</text></svg>',
    {
      headers: {
        'cache-control': 'public, max-age=86400',
        'content-type': 'image/svg+xml; charset=utf-8',
        'x-content-type-options': 'nosniff'
      }
    }
  );
}

function landing(env: Env): Response {
  return html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forge Cloud — remote workspaces for Parallax Review</title>
<meta name="description" content="Give ChatGPT, Codex and Claude an isolated repository, terminal and browser for Parallax Review.">
<style>
:root{--bg:#0e0e12;--surface:#1a1a1f;--ink:#f4f4f6;--muted:#a2a2ad;--line:#2c2c33;--signal:#8b7dff;--grad:#a78bfa;--accent-soft:#221f33;--max:1120px}
*{box-sizing:border-box}html,body{max-width:100%;overflow-x:clip}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}
a{color:inherit}.skip{position:absolute;left:1rem;top:-5rem;background:var(--ink);color:var(--bg);padding:.75rem 1rem;z-index:2}.skip:focus{top:1rem}
header,main,footer{width:min(100% - 3rem,var(--max));margin-inline:auto}header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-block:1.35rem;border-bottom:1px solid var(--line)}
.mark{display:inline-flex;align-items:center;gap:.6rem}.mark .glyph{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--signal),var(--grad));display:grid;place-items:center;color:#fff;font-size:17px;box-shadow:0 3px 12px -3px var(--signal)}.brand{font-weight:750;letter-spacing:-.02em;font-size:1.1rem}.pilot{color:var(--signal);font-size:.78rem;font-weight:700}
main{padding-block:clamp(4.5rem,10vw,8rem)}.hero{max-width:940px}.eyebrow{color:var(--signal);font-size:.78rem;font-weight:750;letter-spacing:.08em;text-transform:uppercase}
h1{max-width:13ch;margin:.28em 0 .32em;font-size:clamp(3rem,7.5vw,6rem);line-height:.94;letter-spacing:-.04em;text-wrap:balance;overflow-wrap:break-word}
.lede{max-width:65ch;margin:0;color:var(--muted);font-size:clamp(1.08rem,1.6vw,1.3rem);text-wrap:pretty}
.actions{display:flex;gap:.75rem;flex-wrap:wrap;margin:2rem 0 0}.actions a{display:inline-flex;min-height:46px;align-items:center;padding:.7rem 1.1rem;background:linear-gradient(135deg,var(--signal),var(--grad));color:#fff;border:1px solid transparent;border-radius:9px;text-decoration:none;font-weight:700;transition:filter 180ms ease-out,color 180ms ease-out,border-color 180ms ease-out,background-color 180ms ease-out}.actions a:hover{filter:brightness(1.08)}.actions a.secondary{background:transparent;color:var(--ink);border-color:var(--line)}.actions a.secondary:hover{border-color:var(--signal);color:var(--signal);filter:none}a:focus-visible{outline:3px solid var(--signal);outline-offset:4px}
.capabilities{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:clamp(4rem,8vw,7rem);border-top:1px solid var(--line)}.capability{min-width:0;padding:1.4rem 2rem 0 0}.capability+.capability{padding-left:2rem;border-left:1px solid var(--line)}.capability h2{margin:0 0 .45rem;font-size:1.05rem}.capability p{max-width:34ch;margin:0;color:var(--muted);font-size:.92rem}
footer{display:flex;justify-content:space-between;gap:1.5rem;padding-block:1.4rem;border-top:1px solid var(--line);color:var(--muted);font-size:.82rem}code{color:var(--signal)}
@media(max-width:700px){header,main,footer{width:min(100% - 2.5rem,var(--max))}main{padding-block:4rem}h1{font-size:clamp(2.85rem,14vw,4.5rem);line-height:.93}.actions{align-items:stretch;flex-direction:column}.actions a{justify-content:center;width:100%}.capabilities{grid-template-columns:1fr;margin-top:4rem}.capability,.capability+.capability{padding:1.25rem 0;border-left:0;border-bottom:1px solid var(--line)}footer{align-items:flex-start;flex-direction:column}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head>
<body><a class="skip" href="#main">Skip to content</a><header><span class="mark"><span class="glyph" aria-hidden="true">⚒</span><span class="brand">Forge</span></span><span class="pilot">Cloud private pilot</span></header><main id="main"><section class="hero"><div class="eyebrow">Remote workspace for AI clients</div><h1>Run Parallax Review from any AI coding client.</h1>
<p class="lede">Forge gives ChatGPT, Codex and Claude an isolated repository, Linux runtime and browser. Parallax defines what to review and what counts as evidence.</p>
<div class="actions"><a href="${env.FORGE_PUBLIC_ORIGIN}/login/github">Continue with GitHub</a><a class="secondary" href="${env.FORGE_PUBLIC_ORIGIN}/.well-known/oauth-protected-resource">Connection metadata</a></div></section>
<section class="capabilities" aria-label="Forge capabilities"><div class="capability"><h2>Repository + terminal</h2><p>Clone, inspect, patch, build and test inside an on-demand workspace.</p></div><div class="capability"><h2>Browser evidence</h2><p>Capture phone and desktop screenshots plus accessibility evidence.</p></div><div class="capability"><h2>Parallax contract</h2><p>Preserve audiences, missions, readiness and honest limitations.</p></div></section></main>
<footer><span><code>${env.FORGE_ENVIRONMENT}</code> environment</span><span>Forge supplies the computer. Parallax supplies the review discipline.</span></footer></body></html>`);
}

function safeError(error: unknown, env: Env): Response {
  if (error instanceof ForgeError) {
    const status = error.code === 'FORGE_AUTH_REQUIRED'
      ? 401
      : error.code === 'FORGE_PERMISSION_DENIED'
        ? 403
        : error.code === 'FORGE_WORKSPACE_NOT_FOUND'
          ? 404
          : 409;
    const headers = status === 401 ? { 'www-authenticate': oauthChallenge(env) } : undefined;
    return json({ error: error.toJSON() }, status, headers);
  }
  console.error('forge_unhandled_error', { name: error instanceof Error ? error.name : 'unknown' });
  return json(
    {
      error: {
        code: 'FORGE_INTERNAL_ERROR',
        message: 'Forge could not complete the request.',
        retryable: false
      }
    },
    500
  );
}

function coordinator(env: Env, workspaceId: string) {
  return env.WORKSPACE_COORDINATORS.get(env.WORKSPACE_COORDINATORS.idFromName(workspaceId));
}

function mcpExecutionContext(ctx: ExecutionContext, props: Record<string, unknown>): ExecutionContext {
  return {
    waitUntil: (promise) => ctx.waitUntil(promise),
    passThroughOnException: () => ctx.passThroughOnException(),
    props
  } as ExecutionContext;
}

// The preview upstream is UNTRUSTED user code, so forwarding is allowlist-only:
// we copy just the minimal set of request headers a normal HTTP client needs and
// drop everything else. An allowlist (vs. deleting a handful of known-sensitive
// names) guarantees no inbound header — auth, cookies, forge-* control headers,
// cf-* edge headers, or anything future — can ever leak into preview content.
const PREVIEW_FORWARD_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'content-length',
  'user-agent',
  'range',
  'if-none-match',
  'if-modified-since'
]);

function cleanPreviewHeaders(request: Request): Headers {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (PREVIEW_FORWARD_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  return headers;
}

async function sandboxPreviewFetch(
  request: Request,
  env: Env,
  detail: Awaited<ReturnType<WorkspaceCoordinator['getPreviewInternal']>>,
  path: string,
  search: string
): Promise<{ response: Response; target: URL }> {
  // Self-hosted workspaces serve their preview from the user's own machine, so
  // proxy through the agent's preview route (over the tunnel) instead of the
  // Cloudflare sandbox binding. Gated on the persisted provider kind, so the
  // Cloudflare path below is untouched for cloud workspaces.
  if (detail.workspace.provider.kind === 'self-hosted') {
    if (!env.FORGE_SELFHOST_URL || !env.FORGE_SELFHOST_TOKEN) {
      throw new ForgeError({
        code: 'FORGE_PREVIEW_UNAVAILABLE',
        message: 'Self-hosted preview backend is not configured.',
        retryable: false
      });
    }
    const base = env.FORGE_SELFHOST_URL.replace(/\/+$/, '');
    const target = new URL(
      `${base}/preview/${encodeURIComponent(detail.providerId)}/${detail.preview.port}${path}`
    );
    target.search = search;
    const headers = cleanPreviewHeaders(request);
    headers.set('authorization', `Bearer ${env.FORGE_SELFHOST_TOKEN}`);
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual'
    });
    return { response, target };
  }
  const target = new URL(path, 'http://forge-container.internal');
  target.search = search;
  const upstreamRequest = new Request(target, {
    method: request.method,
    headers: cleanPreviewHeaders(request),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual'
  });
  const response = await getSandbox(env.Sandbox, detail.providerId, {
    enableDefaultSession: false,
    normalizeId: true,
    sleepAfter: '90s',
    transport: 'rpc'
  }).containerFetch(upstreamRequest, detail.preview.port);
  return { response, target };
}

function assertPreviewActive(expiresAt: string): void {
  if (Date.parse(expiresAt) <= Date.now()) {
    throw new ForgeError({
      code: 'FORGE_PREVIEW_UNAVAILABLE',
      message: 'Preview has expired.',
      retryable: false
    });
  }
}

async function browserPreview(request: Request, env: Env, url: URL): Promise<Response> {
  if (!constantTimeEqual(
    request.headers.get('x-forge-internal-preview') ?? '',
    env.FORGE_INTERNAL_PREVIEW_KEY
  )) {
    throw new ForgeError({
      code: 'FORGE_PERMISSION_DENIED',
      message: 'Browser preview authorization is invalid.',
      retryable: false
    });
  }
  const workspaceId = request.headers.get('x-forge-browser-workspace') ?? '';
  const previewId = request.headers.get('x-forge-browser-preview') ?? '';
  if (!/^ws_[0-9a-hjkmnp-tv-z]{20,32}$/.test(workspaceId) || !/^prv_[0-9a-hjkmnp-tv-z]{20,32}$/.test(previewId)) {
    throw new ForgeError({
      code: 'FORGE_PERMISSION_DENIED',
      message: 'Browser preview scope is invalid.',
      retryable: false
    });
  }
  const prefix = `/__forge_browser/${workspaceId}/${previewId}`;
  const path = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length) || '/'
    : url.pathname;
  const detail = await coordinator(env, workspaceId).getPreviewInternal(previewId);
  assertPreviewActive(detail.preview.expiresAt);
  const { response: upstream, target } = await sandboxPreviewFetch(request, env, detail, path, url.search);
  if (upstream.webSocket) return upstream;
  const size = Number.parseInt(upstream.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(size) && size > 20_000_000) {
    throw new ForgeError({
      code: 'FORGE_OUTPUT_TRUNCATED',
      message: 'Browser preview resource exceeds the 20 MB limit.',
      retryable: false
    });
  }
  const responseHeaders = new Headers(upstream.headers);
  const location = responseHeaders.get('location');
  if (location) {
    const resolved = new URL(location, target);
    responseHeaders.set('location', `${env.FORGE_PUBLIC_ORIGIN}${prefix}${resolved.pathname}${resolved.search}`);
  }
  responseHeaders.set('cache-control', 'private,no-store');
  responseHeaders.set('x-robots-tag', 'noindex,nofollow,noarchive');
  const nullBody = [101, 204, 205, 304].includes(upstream.status);
  const body = nullBody ? null : await upstream.arrayBuffer();
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

async function preview(request: Request, env: Env, url: URL): Promise<Response> {
  const match = url.pathname.match(/^\/preview\/(ws_[^/]+)\/(prv_[^/]+)(\/.*)?$/);
  if (!match) return new Response('Not found', { status: 404 });
  const [, workspaceId = '', previewId = '', rest = '/'] = match;
  const internal = constantTimeEqual(
    request.headers.get('x-forge-internal-preview') ?? '',
    env.FORGE_INTERNAL_PREVIEW_KEY
  );
  if (!internal) {
    const capability = request.headers.get('x-forge-preview-capability') ?? '';
    await verifyCapability(capability, env.FORGE_CAPABILITY_SIGNING_KEY, {
      workspaceId,
      action: `preview:${previewId}`
    });
  }

  const detail = await coordinator(env, workspaceId).getPreviewInternal(previewId);
  assertPreviewActive(detail.preview.expiresAt);

  const directSandbox = detail.workspace.provider.kind === 'cloudflare';
  const direct = directSandbox
    ? await sandboxPreviewFetch(request, env, detail, rest, url.search)
    : undefined;
  const target = direct?.target ?? new URL(detail.preview.providerUrl);
  if (!direct) {
    target.pathname = rest;
    target.search = url.search;
  }
  const upstream = direct?.response ?? await fetch(new Request(target, {
    method: request.method,
    headers: cleanPreviewHeaders(request),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual'
  }));

  if (upstream.webSocket) return upstream;
  const responseHeaders = new Headers(upstream.headers);
  const location = responseHeaders.get('location');
  if (location) {
    const resolved = new URL(location, target);
    responseHeaders.set(
      'location',
      `${env.FORGE_PUBLIC_ORIGIN}/preview/${workspaceId}/${previewId}${resolved.pathname}${resolved.search}`
    );
  }
  responseHeaders.set('x-robots-tag', 'noindex,nofollow,noarchive');
  responseHeaders.set('cache-control', 'private,no-store');
  responseHeaders.set('referrer-policy', 'no-referrer');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

// Authenticated R2 gateway for workspace snapshots. Untrusted container code
// streams `tar czf -` here on PUT and reads it back on GET, scoped by a
// short-lived capability so it can only touch its own workspace's snapshot.
async function snapshotEndpoint(request: Request, env: Env, url: URL): Promise<Response> {
  if (!snapshotsEnabled(env)) return new Response('Snapshots disabled', { status: 404 });
  const match = url.pathname.match(/^\/__forge_snapshot\/(ws_[0-9a-hjkmnp-tv-z]{20,32})$/);
  const workspaceId = match?.[1];
  if (!workspaceId) return new Response('Not found', { status: 404 });
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  let claims;
  try {
    claims = await verifyCapability(token, env.FORGE_CAPABILITY_SIGNING_KEY, { workspaceId, action: `snapshot:${workspaceId}` });
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }
  const key = snapshotKey(claims.tenantId, workspaceId);
  const mpAction = url.searchParams.get('mp');
  if (mpAction && (request.method === 'PUT' || request.method === 'POST')) {
    return await handleMultipartUpload(mpAction, env.ARTIFACTS, key, url, request, async (sizeBytes) => {
      await recordSnapshot(env.METADATA, { workspaceId, tenantId: claims.tenantId, r2Key: key, sizeBytes, createdAt: new Date().toISOString() });
    });
  }
  if (request.method === 'PUT' && request.body) {
    const object = await env.ARTIFACTS.put(key, request.body);
    await recordSnapshot(env.METADATA, { workspaceId, tenantId: claims.tenantId, r2Key: key, sizeBytes: object?.size ?? 0, createdAt: new Date().toISOString() });
    return Response.json({ ok: true, size: object?.size ?? 0 });
  }
  if (request.method === 'GET') {
    const object = await env.ARTIFACTS.get(key);
    if (!object) return new Response('No snapshot', { status: 404 });
    return new Response(object.body, { headers: { 'content-type': 'application/gzip', 'cache-control': 'no-store' } });
  }
  return new Response('Method not allowed', { status: 405 });
}

// Authenticated R2 gateway for the per-repo dependency cache. Mirrors
// snapshotEndpoint, but the object is scoped by CONTENT (cache_key) instead of by
// workspace, so any workspace of the same repo at the same lockfile shares it.
// The cache_key travels in the x-forge-deps-key header; the capability is scoped
// to `deps:<cache_key>` so a container can only touch the exact key it was handed.
async function depsEndpoint(request: Request, env: Env, url: URL): Promise<Response> {
  if (!snapshotsEnabled(env)) return new Response('Deps cache disabled', { status: 404 });
  const match = url.pathname.match(/^\/__forge_deps\/(ws_[0-9a-hjkmnp-tv-z]{20,32})$/);
  const workspaceId = match?.[1];
  if (!workspaceId) return new Response('Not found', { status: 404 });
  const cacheKey = request.headers.get('x-forge-deps-key') ?? '';
  const parsed = parseDepsCacheKey(cacheKey);
  if (!parsed) return new Response('Bad deps key', { status: 400 });
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  try {
    await verifyCapability(token, env.FORGE_CAPABILITY_SIGNING_KEY, { workspaceId, action: `deps:${cacheKey}` });
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }
  const mpAction = url.searchParams.get('mp');
  if (mpAction && (request.method === 'PUT' || request.method === 'POST')) {
    return await handleMultipartUpload(mpAction, env.ARTIFACTS, parsed.r2Key, url, request, async (sizeBytes) => {
      await recordDepsCache(env.METADATA, {
        cacheKey,
        repoSlug: parsed.repoSlug,
        lockfileHash: parsed.lockfileHash,
        runtime: parsed.runtime,
        r2Key: parsed.r2Key,
        sizeBytes,
        createdAt: new Date().toISOString()
      });
    });
  }
  if (request.method === 'PUT' && request.body) {
    const object = await env.ARTIFACTS.put(parsed.r2Key, request.body);
    await recordDepsCache(env.METADATA, {
      cacheKey,
      repoSlug: parsed.repoSlug,
      lockfileHash: parsed.lockfileHash,
      runtime: parsed.runtime,
      r2Key: parsed.r2Key,
      sizeBytes: object?.size ?? 0,
      createdAt: new Date().toISOString()
    });
    return Response.json({ ok: true, size: object?.size ?? 0 });
  }
  if (request.method === 'GET') {
    const object = await env.ARTIFACTS.get(parsed.r2Key);
    if (!object) return new Response('No deps cache', { status: 404 });
    return new Response(object.body, { headers: { 'content-type': 'application/gzip', 'cache-control': 'no-store' } });
  }
  return new Response('Method not allowed', { status: 405 });
}

// Scheduled global reaper: recovers capacity even when nobody is calling
// forge_workspace_create (the lazy reaper only fires on that path). Frees stale
// slots and tears their workspaces down. Best-effort per workspace.
async function reapAbandonedSlots(env: Env): Promise<void> {
  let reclaimed;
  try {
    // With snapshots on, dirty workspaces are eligible for reaping (we snapshot
    // them first); otherwise they stay protected.
    reclaimed = await reclaimStaleSlots(env.METADATA, slotTtlMs(env), Date.now(), !snapshotsEnabled(env));
  } catch (error) {
    console.warn('forge_slot_scheduled_reclaim_failed', {
      reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
    });
    return;
  }
  for (const slot of reclaimed) {
    const workspaceId = slot.workspaceId as WorkspaceId;
    try {
      const destroyId = workflowInstanceId('destroy', workspaceId);
      const stub = env.WORKSPACE_COORDINATORS.get(env.WORKSPACE_COORDINATORS.idFromName(workspaceId));
      // Save the workspace before tearing it down (best-effort, no-op if disabled).
      await stub.snapshotToR2().catch(() => undefined);
      // force: true — reclaimStaleSlots already gated dirty-workspace
      // eligibility on snapshotsEnabled above, so this reap has already
      // decided the unpushed-work loss is acceptable; forgeWorkspaceDestroy's
      // guard would otherwise reject every dirty reap unconditionally.
      await stub.requestDestroy({ idempotencyKey: `reap-${destroyId}`, force: true });
      await env.DESTROY_WORKFLOW.create({
        id: destroyId,
        params: { workspaceId, idempotencyKey: `reap-${destroyId}`, preserveArtifacts: true }
      });
    } catch (error) {
      console.warn('forge_slot_scheduled_teardown_failed', {
        workspaceId: slot.workspaceId,
        reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
      });
    }
  }
}

// Stuck-provisioning watchdog: a provision workflow can die/time out mid-run
// (evicted before its JS catch), leaving the workspace frozen in a non-terminal
// provisioning state — never `failed`, never past the idle TTL — so its D1 slot
// leaks and the tenant cap eventually wedges. This sweep force-fails any slot
// occupant wedged past STUCK_PROVISION_MS via the coordinator's
// markProvisioningExhausted path, then releases its slot. Best-effort per
// workspace: one failure must not abort the rest.
async function reapStuckProvisioning(env: Env): Promise<void> {
  let occupants;
  try {
    occupants = await listSlotOccupants(env.METADATA, slotTtlMs(env), Date.now());
  } catch (error) {
    console.warn('forge_provision_watchdog_scan_failed', {
      reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
    });
    return;
  }
  for (const occupant of occupants) {
    if (!occupant.stuckProvisioning) continue;
    const workspaceId = occupant.workspaceId as WorkspaceId;
    try {
      // Force the DO terminal (`failed`) so it stops reporting a non-terminal
      // state, then free the leaked slot.
      const result = await coordinator(env, workspaceId).provisionExhausted();
      await releaseWorkspaceSlot(env.METADATA, workspaceId);
      console.log('forge_provision_watchdog_reaped', {
        slot: occupant.slot,
        tenantId: occupant.tenantId,
        workspaceId: occupant.workspaceId,
        priorState: occupant.state,
        state: result.state,
        idleMinutes: occupant.idleMinutes
      });
    } catch (error) {
      console.warn('forge_provision_watchdog_failed', {
        workspaceId: occupant.workspaceId,
        reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
      });
    }
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Force-fail wedged provisioning slots first so they surface as `failed` and
    // release their slots, then run the general stale-slot reaper for the rest.
    ctx.waitUntil(reapStuckProvisioning(env).then(() => reapAbandonedSlots(env)));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/favicon.ico' && request.method === 'GET') return favicon();
      if (url.pathname.startsWith('/__forge_snapshot/')) return await snapshotEndpoint(request, env, url);
      if (url.pathname.startsWith('/__forge_deps/')) return await depsEndpoint(request, env, url);
      if (url.pathname.startsWith('/git/')) return await gitCredentialProxy(request, env);
      if (
        url.pathname.startsWith('/__forge_browser/') ||
        request.headers.has('x-forge-browser-workspace') ||
        request.headers.has('x-forge-browser-preview')
      ) {
        return await browserPreview(request, env, url);
      }

      if (url.pathname === '/health') {
        return json({
          ok: true,
          service: 'forge-edge-gateway',
          version: '0.1.0',
          environment: env.FORGE_ENVIRONMENT
        });
      }
      if (url.pathname === '/ready') {
        const [database] = await Promise.all([
          env.METADATA.prepare('SELECT 1 AS ok').first<{ ok: number }>(),
          env.ARTIFACTS.list({ limit: 1 })
        ]);
        return json({
          ok: database?.ok === 1,
          service: 'forge-edge-gateway',
          environment: env.FORGE_ENVIRONMENT,
          bindings: { metadata: 'ready', artifacts: 'ready', browser: 'configured', sandbox: 'configured' }
        }, database?.ok === 1 ? 200 : 503);
      }
      if (
        url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp'
      ) {
        return json({
          resource: `${env.FORGE_PUBLIC_ORIGIN}/mcp`,
          authorization_servers: [
            env.FORGE_OAUTH_AUTHORIZATION_SERVER ?? env.FORGE_OAUTH_ISSUER ?? env.FORGE_PUBLIC_ORIGIN
          ],
          scopes_supported: ['forge:workspace'],
          bearer_methods_supported: ['header']
        });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(authorizationServerMetadata(env));
      }
      if (url.pathname === '/login/github') return await startGitHubLogin(request, env);
      if (url.pathname === '/login/github/callback') return await finishGitHubLogin(request, env);
      if (url.pathname === '/logout') return await logout(request, env);
      if (url.pathname === '/app') return await appDashboard(request, env);
      if (url.pathname === '/github/install') return await installGitHubApp(request, env);
      if (url.pathname === '/github/setup') return await finishGitHubInstall(request, env);
      const approvalMatch = url.pathname.match(/^\/approvals\/(apr_[0-9a-hjkmnp-tv-z]{20,32})$/u);
      if (approvalMatch?.[1]) return await approvalPage(request, env, approvalMatch[1]);
      if (url.pathname === '/oauth/register' && request.method === 'POST') {
        return await registerClient(request, env);
      }
      if (url.pathname === '/oauth/authorize') {
        return await authorize(request, env);
      }
      if (url.pathname === '/oauth/token' && request.method === 'POST') {
        return await token(request, env);
      }
      if (url.pathname === '/mcp') {
        const auth = await authenticate(request, env);
        const mcpContext = mcpExecutionContext(ctx, auth as unknown as Record<string, unknown>);
        return await ForgeMcpSession.serve('/mcp', {
          binding: 'MCP_SESSIONS',
          transport: 'streamable-http'
        }).fetch(request, env, mcpContext);
      }
      if (url.pathname.startsWith('/preview/')) return await preview(request, env, url);
      if (url.pathname === '/openapi.json') return json(openapi);
      if (url.pathname === '/github/webhooks' && request.method === 'POST') return await githubWebhook(request, env);
      if (url.pathname === '/' && request.method === 'GET') return landing(env);
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return safeError(error, env);
    }
  }
} satisfies ExportedHandler<Env>;
