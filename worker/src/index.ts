import { ForgeMcpSession, SERVER_VERSION } from './mcp';
import { authenticate, bindSessionId, sessionIdFor } from './identity';
import {
  authorizationServerMetadata,
  authorize,
  callback,
  protectedResourceMetadata,
  registerClient,
  token
} from './oauth';
import { approvalPage, resolveApproval } from './approve';
import { installedPage, landingPage } from './landing';
import { privacyPage } from './privacy';
import { iconResponse } from './icon';
import { userRequestFor } from './user-token';
import type { Env } from './env';
import { toForgeError } from './errors';

export { ForgeMcpSession };

/**
 * The whole surface. Operational capabilities reach the outside world through
 * the MCP endpoint, OAuth and approval pages. The landing, privacy notice,
 * icons and health route are public information surfaces only.
 *
 * There is no dashboard, observer API, task console, workspace console or
 * capture gallery. Evidence from forge_see is returned inline with that call.
 */

/**
 * Resolve the GitHub credentials an approval must be carried out with.
 *
 * This is the boundary `approve.ts` cannot hold from inside itself: it is
 * handed a request function and has no way to check whose it is. If this
 * resolved the wrong user, one user's click would act on another
 * user's repository, and nothing downstream would notice.
 *
 * So the credential is derived from the approval row's own `user_id` — never
 * from the caller, who is an anonymous browser holding a link.
 */
async function credentialForApproval(env: Env, approvalId: string): Promise<Awaited<ReturnType<typeof userRequestFor>> | null> {
  const row = await env.METADATA.prepare(
    `SELECT u.id AS user_id
       FROM approvals a
       JOIN users u ON u.id = a.user_id
      WHERE a.id = ?1`
  )
    .bind(approvalId)
    .first<{ user_id: string }>();

  if (!row?.user_id) return null;
  return async (path, init) => (await userRequestFor(env, row.user_id))(path, init);
}

async function handleApproval(
  env: Env,
  request: Request,
  url: URL,
  id: string,
  ctx: ExecutionContext
): Promise<Response> {
  const token = url.searchParams.get('t') ?? '';

  // GET renders; only POST decides.
  //
  // Approval links get pasted into chats, and chat clients unfurl them, mail
  // scanners fetch them, and browsers prefetch them. If loading the page could
  // resolve the approval, a link preview would merge someone's branch.
  if (request.method === 'GET') {
    return approvalPage(env, id, token);
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
  }

  const form = await request.formData().catch(() => null);
  const decision = form?.get('decision');
  if (decision !== 'approve' && decision !== 'reject') {
    return new Response('Bad request', { status: 400 });
  }

  const gh = await credentialForApproval(env, id);
  if (!gh) {
    // Rendered the same way an invalid link is: whether an approval exists is
    // not something an unauthenticated visitor should be able to learn.
    return approvalPage(env, id, 'invalid');
  }

  return resolveApproval(env, id, token, decision, gh, (promise) => ctx.waitUntil(promise));
}

/**
 * Where this worker is mounted, derived from the one value that already has to
 * be right.
 *
 * Forge is served at a path (`timcoy.uk/forge`), not a hostname, so every
 * request arrives with that prefix on it while the router matches bare paths.
 * FORGE_PUBLIC_ORIGIN is what OAuth redirects and approval links are minted
 * from, so it must already name the mount point exactly — which makes it the
 * only honest source for this, and keeps the two from ever disagreeing.
 *
 * Mounted at a root origin the prefix is empty and this does nothing.
 */
function mountPath(env: Env): string {
  try {
    return new URL(env.FORGE_PUBLIC_ORIGIN).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const mount = mountPath(env);
    const path =
      mount && (url.pathname === mount || url.pathname.startsWith(`${mount}/`))
        ? url.pathname.slice(mount.length) || '/'
        : url.pathname;

    // Browser preflights carry no bearer credential. Answer before authentication;
    // these endpoints use explicit tokens/PKCE, never ambient browser cookies.
    const corsRoute = path === '/mcp' || path === '/oauth/register' || path === '/oauth/token' ||
      path.startsWith('/.well-known/oauth-') || url.pathname.startsWith('/.well-known/oauth-');
    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Accept, Authorization, MCP-Session-Id, MCP-Protocol-Version, MCP-Method',
      'access-control-expose-headers': 'WWW-Authenticate, MCP-Session-Id',
      'access-control-max-age': '86400'
    };
    if (corsRoute && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    try {
      // The mount point. Not a dashboard and not a console — the one page that
      // answers what this is and how to connect it, because otherwise the URL a
      // person is handed is a 404.
      if (path === '/' || path === '') {
        // GitHub returns people here after installing, with setup_action set.
        // They have already decided what Forge is; what they need now is
        // confirmation and the one step that might be left.
        const setup = url.searchParams.get('setup_action');
        return setup ? installedPage(env, setup) : landingPage(env);
      }

      if (path === '/privacy') {
        return privacyPage(env);
      }

      // The mark, at a stable URL for a favicon, an unfurler and anyone who
      // needs the file. Before auth, because none of those three can carry a
      // token.
      const icon = iconResponse(path);
      if (icon) return icon;

      if (path === '/health') {
        return Response.json({ status: 'ok', version: SERVER_VERSION });
      }

      // Discovery, in every spelling a client might try.
      //
      // RFC 8414 says the well-known segment is inserted between host and path,
      // so an issuer of `https://timcoy.uk/forge` is probed at
      // `/.well-known/oauth-authorization-server/forge`. Plenty of clients
      // instead append, giving `/forge/.well-known/oauth-authorization-server`.
      // Both arrive here — the first unstripped, the second with the mount
      // removed — and a wrong guess surfaces to the user as nothing more useful
      // than "connection failed", so both are answered.
      const wellKnown = /^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server)(\/.*)?$/;
      const discovery = wellKnown.exec(path) ?? wellKnown.exec(url.pathname);
      if (discovery) {
        return discovery[1] === 'oauth-protected-resource'
          ? protectedResourceMetadata(env)
          : authorizationServerMetadata(env);
      }

      if (path === '/oauth/register') return await registerClient(env, request);
      if (path === '/oauth/authorize') return await authorize(env, request);
      if (path === '/oauth/callback') return await callback(env, request);
      if (path === '/oauth/token') return await token(env, request);

      const approval = /^\/approvals\/([A-Za-z0-9-]+)$/.exec(path);
      if (approval?.[1]) {
        return await handleApproval(env, request, url, approval[1], ctx);
      }

      if (path === '/mcp') {
        // Authenticate before the session exists. Identity is passed as props
        // rather than re-derived inside, so a session can never outlive or
        // disagree with the token that opened it.
        const identity = await authenticate(env, request);
        // ChatGPT probes the stateless 2026-07-28 protocol first. The current
        // Agents transport implements the initialized 2025 protocol, whose
        // correct response to the new discovery RPC is a 404 JSON-RPC
        // Method-not-found error. That status is what tells a dual-era client
        // to fall back; passing the probe into the old transport yields 400
        // instead and aborts discovery entirely.
        if (request.headers.get('mcp-method') === 'server/discover') {
          const message = await request.clone().json().catch(() => null) as { id?: unknown } | null;
          return Response.json(
            {
              jsonrpc: '2.0',
              id: message?.id ?? null,
              error: { code: -32601, message: 'Method not found' }
            },
            { status: 404, headers: corsHeaders }
          );
        }
        // The public Worker is mounted at /forge, but the Agents router is
        // mounted at /mcp. It matches the URL it receives, not the normalized
        // `path` above, so hand it the same stripped path the outer router used.
        const sessionUrl = new URL(request.url);
        sessionUrl.pathname = path;
        const sessionRequest = new Request(sessionUrl, request);
        const publicSessionId = request.headers.get('mcp-session-id');
        if (publicSessionId) {
          const internalSessionId = await sessionIdFor(env, identity.userId, publicSessionId);
          if (!internalSessionId) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }, { status: 404, headers: corsHeaders });
          sessionRequest.headers.set('mcp-session-id', internalSessionId);
        }
        const response = await ForgeMcpSession.serve('/mcp', { binding: 'MCP_SESSIONS' }).fetch(sessionRequest, env, {
          ...ctx,
          props: { identity }
        } as ExecutionContext & { props: { identity: typeof identity } });
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
        const internalSessionId = response.headers.get('mcp-session-id');
        if (internalSessionId) headers.set('mcp-session-id', await bindSessionId(env, identity.userId, internalSessionId));
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      const forge = toForgeError(error);

      // An unauthenticated MCP call must say where to authenticate, or the
      // client has no way to start the OAuth flow it is capable of running.
      if (forge.code === 'FORGE_AUTH_REQUIRED') {
        return Response.json(
          { error: forge.code, message: forge.message, ...(forge.details ? { details: forge.details } : {}) },
          {
            status: 401,
            headers: {
              ...(corsRoute ? corsHeaders : {}),
              'www-authenticate': `Bearer resource_metadata="${env.FORGE_PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`
            }
          }
        );
      }

      return Response.json(
        { error: forge.code, message: forge.message },
        { status: forge.retryable ? 503 : 400, headers: corsRoute ? corsHeaders : {} }
      );
    }
  }
} satisfies ExportedHandler<Env>;
