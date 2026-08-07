import { getSandbox, Sandbox, ContainerProxy } from '@cloudflare/sandbox';
import { ForgeError, type WorkspaceId, type TenantId } from '@forge/core';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import { listSlotOccupants, reclaimStaleSlots, releaseWorkspaceSlot, slotTtlMs } from './capacity';
import { verifyCapability } from '@forge/capabilities';
import openapi from '../../../openapi/forge.openapi.json';
import { ForgeMcpSession } from './mcp-session';
import { SiteReviewWorkflow } from './site-review-workflow';
import { ChatOperationWorkflow } from './chat-operation-workflow';
import { WorkspaceCoordinator } from './workspace-coordinator';
import { workspaceOperations, type WorkspaceOperations } from './workspace-operations';
import { ProvisionWorkspaceWorkflow, DestroyWorkspaceWorkflow } from './workflows';
import { authenticate, constantTimeEqual, oauthChallenge } from './auth';
import {
  authorizationServerMetadata,
  authorize,
  registerClient,
  token
} from './oauth';
import type { Env } from './env';
import { galleryPage } from './review-gallery';
import { chatOperationStatusPage } from './chat-operations';
import { secretsDashboard } from './secrets-ui';
import { forgeGlyph } from './ui';
import { liveApiSnapshot, liveApiWorkspaceDetail, liveDashboardPage, liveApiStream } from './live-dashboard';
import {
  appDashboard,
  approvalPage,
  resolveAccessRequest,
  approvalPreviewEndpoint,
  cookie,
  finishGitHubInstall,
  finishGitHubLogin,
  githubWebhook,
  gitCredentialProxy,
  installGitHubApp,
  reconnectGitHub,
  logout,
  startGitHubLogin
} from './github';

export {
  Sandbox,
  ContainerProxy,
  ForgeMcpSession,
  SiteReviewWorkflow,
  ChatOperationWorkflow,
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
  // Unified product icon for pinned tabs, portal, and shared links.
  return new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0d0d0d"/><path d="M4 7.6H18l3.8 2a.5.5 0 0 1 0 .9L18 12.4h-3.7v3.2h3.2a1.15 1.15 0 0 1 1.15 1.15V18.6H5.35v-1.85A1.15 1.15 0 0 1 6.5 15.6h3.2v-3.2H6.3A2.3 2.3 0 0 1 4 10.1V7.6Z" fill="#fff" transform="translate(0 .2) scale(.94) translate(.75 .5)"/></svg>',
    {
      headers: {
        'cache-control': 'public, max-age=86400',
        'content-type': 'image/svg+xml; charset=utf-8',
        'x-content-type-options': 'nosniff'
      }
    }
  );
}

async function operatorForceDestroy(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const expected = env.FORGE_OWNER_AUTH_TOKEN?.trim();
  const supplied = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim() ?? '';
  if (!expected || !supplied || !constantTimeEqual(supplied, expected)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const match = /^\/__forge_operator\/workspaces\/(ws_[A-Za-z0-9_-]+)\/destroy$/u.exec(url.pathname);
  if (!match?.[1]) return json({ error: 'invalid_workspace' }, 400);
  const workspaceId = match[1] as WorkspaceId;
  const idempotencyKey = `operator-destroy-${crypto.randomUUID()}`;
  const requested = await workspaceOperations(env, workspaceId).requestDestroy({ idempotencyKey, force: true });
  if (requested.state !== 'destroyed') {
    const workflowId = `operator-${workflowInstanceId('destroy', workspaceId)}-${crypto.randomUUID()}`;
    await env.DESTROY_WORKFLOW.create({
      id: workflowId,
      params: { workspaceId, idempotencyKey, preserveArtifacts: true, force: true }
    });
  }
  return json({ workspace_id: workspaceId, state: requested.state, force: true }, 202);
}


// Distinct monoline marks per landing card to visually differentiate content.
const cardIcon = (paths: string): string =>
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON_PAGE = cardIcon('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18"/><path d="M7 6.5h.01"/>');
const ICON_CODE = cardIcon('<path d="m9 8-5 4 5 4"/><path d="m15 8 5 4-5 4"/>');
const ICON_APPROVE = cardIcon('<path d="M20 6 9.5 17 4 11.5"/>');

function landing(env: Env): Response {
  return html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forge — a real computer for your AI chat</title>
<meta name="description" content="Screenshot any site, build and fix real repositories, and get a pull request to approve — from an ordinary ChatGPT or Claude conversation.">
<style>
:root{color-scheme:light dark;--bg:#fff;--panel:#f7f7f8;--ink:#0d0d0d;--muted:#6e6e80;--line:#e5e5e5;--ring:#0d0d0d}
@media(prefers-color-scheme:dark){:root{--bg:#0d0d0d;--panel:#161616;--ink:#ececf1;--muted:#9a9aa6;--line:#2a2a2a;--ring:#ececf1}}
*{box-sizing:border-box}html,body{max-width:100%;overflow-x:clip}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.skip{position:absolute;left:1rem;top:-4rem;background:var(--ink);color:var(--bg);padding:.7rem 1rem;border-radius:8px;z-index:9}.skip:focus{top:1rem}
.wrap{width:min(100% - 2.5rem,64rem);margin-inline:auto}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.1rem 0}
.mark{display:inline-flex;align-items:center;gap:.6rem;font-weight:600;letter-spacing:-.01em}
.mark .box{width:32px;height:32px;border-radius:9px;border:1px solid var(--line);background:var(--panel);display:grid;place-items:center}
.nav{display:flex;align-items:center;gap:.4rem}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:.55rem 1.05rem;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;font-weight:500;text-decoration:none;transition:background 140ms ease,border-color 140ms ease}
.btn:hover{background:var(--panel)}
.btn.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}.btn.primary:hover{opacity:.88}
.btn:focus-visible,a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
main{padding:clamp(3.5rem,10vw,7rem) 0 clamp(3rem,8vw,5rem)}
h1{margin:0 0 1rem;font-size:clamp(2.4rem,6vw,4rem);line-height:1.05;letter-spacing:-.035em;max-width:16ch;text-wrap:balance}
.lede{margin:0;max-width:52ch;color:var(--muted);font-size:clamp(1.05rem,1.6vw,1.2rem);text-wrap:pretty}
.cta{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:2rem}
.tag{display:inline-flex;align-items:center;gap:.5rem;margin-bottom:1.4rem;padding:.3rem .7rem;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:.82rem}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));gap:1rem;margin-top:clamp(3.5rem,8vw,5.5rem)}
.card{padding:1.4rem;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
.card h2{margin:.9rem 0 .4rem;font-size:1.02rem;letter-spacing:-.01em}
.card p{margin:0;color:var(--muted);font-size:.94rem}
.card .box{width:34px;height:34px;border-radius:10px;border:1px solid var(--line);background:var(--bg);display:grid;place-items:center;color:var(--muted)}
.steps{margin-top:clamp(3.5rem,8vw,5.5rem);border-top:1px solid var(--line);padding-top:2.2rem}
.steps h2{margin:0 0 1.4rem;font-size:1.15rem;letter-spacing:-.015em}
ol{margin:0;padding:0;list-style:none;display:grid;gap:1rem;counter-reset:step}
ol li{counter-increment:step;display:grid;grid-template-columns:1.9rem minmax(0,1fr);grid-auto-flow:column;gap:.9rem;color:var(--muted);align-items:start}
ol li>span{grid-column:2}
ol li::before{content:counter(step);display:grid;place-items:center;width:1.9rem;height:1.9rem;border:1px solid var(--line);border-radius:50%;color:var(--ink);font-size:.82rem;font-variant-numeric:tabular-nums}
ol li b{color:var(--ink);font-weight:600}
footer{border-top:1px solid var(--line);padding:1.6rem 0 2.4rem;color:var(--muted);font-size:.85rem;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
@media(max-width:640px){.cta{flex-direction:column;align-items:stretch}.cta .btn{width:100%}.nav .btn{padding:.5rem .8rem}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head>
<body><a class="skip" href="#main">Skip to content</a>
<div class="wrap"><header>
<span class="mark"><span class="box">${forgeGlyph(19)}</span>Forge</span>
<nav class="nav"><a class="btn" href="${env.FORGE_PUBLIC_ORIGIN}/login/github">Sign in</a><a class="btn primary" href="${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=%2Fapp">Request access</a></nav>
</header></div>
<main id="main"><div class="wrap">
<span class="tag"><span class="dot"></span>Private pilot — access by approval</span>
<h1>A real computer for your AI chat.</h1>
<p class="lede">Forge gives ChatGPT and Claude a browser and a Linux workspace. Screenshot any site, build and fix real repositories, and get a pull request waiting for you to approve — from an ordinary conversation, with nothing to install.</p>
<div class="cta">
<a class="btn primary" href="${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=%2Fapp">Request access</a>
<a class="btn" href="${env.FORGE_PUBLIC_ORIGIN}/login/github">I already have access</a>
</div>

<div class="cards">
<div class="card"><span class="box">${ICON_PAGE}</span><h2>See any page</h2><p>Ask for a screenshot of a URL and get the images back in the same reply, at phone and desktop, without starting anything.</p></div>
<div class="card"><span class="box">${ICON_CODE}</span><h2>Change real code</h2><p>Forge opens your repository in a disposable Linux workspace, runs the tests, and shows you what it did.</p></div>
<div class="card"><span class="box">${ICON_APPROVE}</span><h2>You approve, later</h2><p>Finished work waits in your queue. Approve whenever suits you and Forge opens the pull request itself — nothing sits blocked on you.</p></div>
</div>

<section class="steps"><h2>How it works</h2><ol>
<li><span><b>Request access.</b> Sign in with GitHub and your request comes to the owner for approval.</span></li>
<li><span><b>Connect once.</b> Paste one URL into ChatGPT or Claude. There is nothing to install and nothing to run locally.</span></li>
<li><span><b>Just ask.</b> Screenshot a page, fix a bug, try a design. Forge picks the cheapest way to do it.</span></li>
<li><span><b>Approve in your own time.</b> Anything that touches your repository waits for you, on the web or your phone.</span></li>
</ol></section>
</div></main>
<div class="wrap"><footer><span>Forge — ${env.FORGE_ENVIRONMENT}</span><span>Screenshots, workspaces and pull requests for AI chat.</span></footer></div>
</body></html>`);
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

function mcpExecutionContext(ctx: ExecutionContext, props: Record<string, unknown>): ExecutionContext {
  return {
    waitUntil: (promise) => ctx.waitUntil(promise),
    passThroughOnException: () => ctx.passThroughOnException(),
    props
  } as ExecutionContext;
}

// Untrusted upstream preview: Request headers are strictly allowlisted. Guarantees no inbound auth, cookies, forge-*, or cf-* edge headers leak into preview content.
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
  detail: Awaited<ReturnType<WorkspaceOperations['getPreviewInternal']>>,
  path: string,
  search: string
): Promise<{ response: Response; target: URL }> {
  // Removed unreachable self-hosted sandbox branch (provider deprecated). Prevents agent halluncinations. FORGE_SELFHOST_* retained for self-hosted browser subsystem (browser-router.ts).
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
    sleepAfter: '10m',
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
  const detail = await workspaceOperations(env, workspaceId).getPreviewInternal(previewId);
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
    // Capability transport: Agents use headers. Humans navigating from approval page use path-scoped HttpOnly cookie (browser lacks custom header capability). Query string rejected to prevent history/log leakage.
    const capability = request.headers.get('x-forge-preview-capability')
      || cookie(request, `forge_preview_${previewId}`)
      || '';
    await verifyCapability(capability, env.FORGE_CAPABILITY_SIGNING_KEY, {
      workspaceId,
      action: `preview:${previewId}`
    });
  }

  const detail = await workspaceOperations(env, workspaceId).getPreviewInternal(previewId);
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

// Scheduled global reaper: Best-effort recovery of stale capacity slots and workspace teardown independently of forge_workspace_create lazy reaping.
async function reapAbandonedSlots(env: Env): Promise<void> {
  let reclaimed;
  try {
    // Executor files are deliberately ephemeral, so stale sessions never hold
    // capacity merely because a command changed the checkout.
    reclaimed = await reclaimStaleSlots(env.METADATA, slotTtlMs(env), Date.now());
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
      // Reaping intentionally discards executor state. GitHub remains the only
      // durable repository plane.
      await workspaceOperations(env, workspaceId).requestDestroy({ idempotencyKey: `reap-${destroyId}`, force: true });
      await env.DESTROY_WORKFLOW.create({
        id: destroyId,
        params: { workspaceId, idempotencyKey: `reap-${destroyId}`, preserveArtifacts: true, force: true }
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
      const result = await workspaceOperations(env, workspaceId).provisionExhausted();
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
    const url = new URL(request.url);
    try {
      if (url.pathname === '/favicon.ico' && request.method === 'GET') return favicon();
      if (url.pathname.startsWith('/__forge_operator/workspaces/')) return await operatorForceDestroy(request, env, url);
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
        const requiredSecrets = {
          capabilitySigning: Boolean(env.FORGE_CAPABILITY_SIGNING_KEY),
          credentialEncryption: Boolean(env.FORGE_CREDENTIAL_ENCRYPTION_KEY),
          internalPreview: Boolean(env.FORGE_INTERNAL_PREVIEW_KEY)
        };
        const missingSecrets = Object.entries(requiredSecrets)
          .filter(([, present]) => !present)
          .map(([name]) => name);
        const [database] = await Promise.all([
          env.METADATA.prepare('SELECT 1 AS ok').first<{ ok: number }>(),
          env.ARTIFACTS.list({ limit: 1 })
        ]);
        const configured = database?.ok === 1 && missingSecrets.length === 0;
        const ready = configured;
        return json({
          ok: ready,
          service: 'forge-edge-gateway',
          environment: env.FORGE_ENVIRONMENT,
          bindings: { metadata: 'ready', artifacts: 'ready', browser: 'configured', sandbox: 'configured' },
          executor: {
            mode: 'lazy_ephemeral',
            configured: true,
            requiredForGitHubCrud: false
          },
          ...(configured ? {} : { missing: missingSecrets })
        }, ready ? 200 : 503);
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
      if (url.pathname === '/app/live') return await liveDashboardPage(request, env);
      if (url.pathname === '/app/api/live' && request.method === 'GET') {
        try {
          return await liveApiSnapshot(request, env);
        } catch (error) {
          if (error instanceof ForgeError && error.code === 'FORGE_PERMISSION_DENIED') {
            return json({ error: error.message }, 401);
          }
          throw error;
        }
      }
      const liveDetailMatch = url.pathname.match(/^\/app\/api\/live\/(ws_[0-9a-hjkmnp-tv-z]{20,32})$/u);
      if (liveDetailMatch?.[1] && request.method === 'GET') {
        try {
          return await liveApiWorkspaceDetail(request, env, liveDetailMatch[1]);
        } catch (error) {
          if (error instanceof ForgeError && error.code === 'FORGE_PERMISSION_DENIED') {
            return json({ error: error.message }, 401);
          }
          throw error;
        }
      }
      if (url.pathname === '/app/api/live/stream' && request.method === 'GET') {
        try {
          return await liveApiStream(request, env);
        } catch (error) {
          if (error instanceof ForgeError && error.code === 'FORGE_PERMISSION_DENIED') {
            return json({ error: error.message }, 401);
          }
          throw error;
        }
      }
      if (url.pathname === '/app/secrets' && (request.method === 'GET' || request.method === 'POST')) {
        return await secretsDashboard(request, env);
      }
      if (url.pathname === '/app/access' && request.method === 'POST') return await resolveAccessRequest(request, env);
      if (url.pathname === '/github/install') return await installGitHubApp(request, env);
      if (url.pathname === '/github/reconnect' && request.method === 'POST') return await reconnectGitHub(request, env);
      if (url.pathname === '/github/setup') return await finishGitHubInstall(request, env);
      const galleryMatch = url.pathname.match(/^\/gallery\/((?:ws|srv)_[0-9a-hjkmnp-tv-z]{20,32})\/(art_[0-9a-hjkmnp-tv-z]{20,32})$/u);
      if (galleryMatch?.[1] && galleryMatch[2]) return await galleryPage(request, env, galleryMatch[1], galleryMatch[2]);
      const statusMatch = url.pathname.match(/^\/status\/(op_[0-9a-hjkmnp-tv-z]{20,32})$/u);
      if (statusMatch?.[1] && request.method === 'GET') return await chatOperationStatusPage(request, env, statusMatch[1]);
      const previewMatch = url.pathname.match(/^\/approvals\/(apr_[0-9a-hjkmnp-tv-z]{20,32})\/preview$/u);
      if (previewMatch?.[1]) return await approvalPreviewEndpoint(request, env, previewMatch[1]);
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
