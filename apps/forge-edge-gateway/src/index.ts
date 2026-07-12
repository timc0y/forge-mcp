import { getSandbox, Sandbox, ContainerProxy } from '@cloudflare/sandbox';
import { ForgeError } from '@forge/core';
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

function landing(env: Env): Response {
  return html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forge Cloud — remote workspaces for Parallax Review</title>
<meta name="description" content="Give ChatGPT, Codex and Claude an isolated repository, terminal and browser for Parallax Review.">
<style>body{margin:0;background:#0b0d10;color:#f6f7f9;font:16px/1.55 ui-sans-serif,system-ui}main{max-width:920px;margin:auto;padding:8rem 1.5rem}p{color:#b8bec8;max-width:720px}h1{font-size:clamp(2.8rem,8vw,6rem);line-height:.95;letter-spacing:-.06em;margin:.3em 0}.eyebrow{color:#8ae6b2;text-transform:uppercase;letter-spacing:.14em;font-size:.8rem}.actions{display:flex;gap:.75rem;flex-wrap:wrap;margin:2rem 0}.actions a{color:#0b0d10;background:#f6f7f9;padding:.8rem 1rem;border-radius:.55rem;text-decoration:none;font-weight:650}.actions a.secondary{color:#f6f7f9;background:#20242b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin-top:4rem}.card{border:1px solid #2a3039;border-radius:.8rem;padding:1.2rem;background:#111419}.card h2{font-size:1rem;margin:0 0 .4rem}.card p{font-size:.92rem;margin:0}code{color:#8ae6b2}</style></head>
<body><main><div class="eyebrow">Forge Cloud private pilot</div><h1>Run Parallax Review from any AI coding client.</h1>
<p>Forge gives ChatGPT, Codex and Claude an isolated repository, Linux runtime and browser. Parallax defines what to review and what counts as evidence.</p>
<div class="actions"><a href="${env.FORGE_PUBLIC_ORIGIN}/mcp">MCP endpoint</a><a class="secondary" href="${env.FORGE_PUBLIC_ORIGIN}/.well-known/oauth-protected-resource">Connection metadata</a></div>
<div class="grid"><div class="card"><h2>Repository + terminal</h2><p>Clone, inspect, patch, build and test inside an on-demand workspace.</p></div><div class="card"><h2>Browser evidence</h2><p>Capture phone and desktop screenshots plus accessibility evidence.</p></div><div class="card"><h2>Parallax contract</h2><p>Preserve audiences, missions, readiness and honest limitations.</p></div></div>
<p style="margin-top:4rem"><code>${env.FORGE_ENVIRONMENT}</code> · Forge supplies the computer. Parallax supplies the review discipline.</p></main></body></html>`);
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

function cleanPreviewHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.delete('cookie');
  headers.delete('x-forge-preview-capability');
  headers.delete('x-forge-internal-preview');
  headers.delete('x-forge-browser-workspace');
  headers.delete('x-forge-browser-preview');
  return headers;
}

async function sandboxPreviewFetch(
  request: Request,
  env: Env,
  detail: Awaited<ReturnType<WorkspaceCoordinator['getPreviewInternal']>>,
  path: string,
  search: string
): Promise<{ response: Response; target: URL }> {
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
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
      if (url.pathname === '/github/webhooks') {
        return json(
          {
            error: {
              code: 'FORGE_NOT_IMPLEMENTED',
              message: 'GitHub webhooks are unavailable until the credential proxy is configured.',
              retryable: false
            }
          },
          501
        );
      }
      if (url.pathname === '/' && request.method === 'GET') return landing(env);
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return safeError(error, env);
    }
  }
} satisfies ExportedHandler<Env>;
