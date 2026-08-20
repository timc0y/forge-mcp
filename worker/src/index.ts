import { ForgeMcpSession } from './mcp';
import { authenticate } from './identity';
import {
  authorizationServerMetadata,
  authorize,
  callback,
  protectedResourceMetadata,
  registerClient,
  token
} from './oauth';
import { approvalPage, resolveApproval } from './approve';
import { galleryPage } from './gallery';
import { githubRequest } from './github';
import type { Env } from './env';
import { toForgeError } from './errors';

export { ForgeMcpSession };

/**
 * The whole surface. Five things reach the outside world: the MCP endpoint, the
 * OAuth dance that lets a client reach it, the approval pages where the two
 * irreversible acts are authorized, a stored capture, and health.
 *
 * There is no dashboard, no observer API, no task or workspace console. Every
 * one of those existed in the previous system and every one was a surface to
 * keep working, secure and honest. The capture page earns its place because
 * clients disagree about rendering inline images, so it is the only copy of
 * that evidence guaranteed to be viewable — and the only one that outlives the
 * conversation.
 */

/**
 * Resolve the GitHub credentials an approval must be carried out with.
 *
 * This is the boundary `approve.ts` cannot hold from inside itself: it is
 * handed a request function and has no way to check whose it is. If this
 * resolved the wrong installation, one user's click would act on another
 * user's repository, and nothing downstream would notice.
 *
 * So the credential is derived from the approval row's own `user_id` — never
 * from the caller, who is an anonymous browser holding a link.
 */
async function credentialForApproval(env: Env, approvalId: string): Promise<Awaited<ReturnType<typeof githubRequest>> | null> {
  const row = await env.METADATA.prepare(
    `SELECT u.installation_id AS installation_id
       FROM approvals a
       JOIN users u ON u.id = a.user_id
      WHERE a.id = ?1`
  )
    .bind(approvalId)
    .first<{ installation_id: string | null }>();

  if (!row?.installation_id) return null;
  return githubRequest(env, row.installation_id);
}

async function handleApproval(env: Env, request: Request, url: URL, id: string): Promise<Response> {
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

  return resolveApproval(env, id, token, decision, gh);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/health') {
        return Response.json({ status: 'ok' });
      }

      // Discovery. Both spellings are served because clients differ on which
      // they probe, and a wrong guess reads to the user as "connection failed".
      if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
        return protectedResourceMetadata(env);
      }
      if (path === '/.well-known/oauth-authorization-server') {
        return authorizationServerMetadata(env);
      }

      if (path === '/oauth/register') return registerClient(env, request);
      if (path === '/oauth/authorize') return authorize(env, request);
      if (path === '/oauth/callback') return callback(env, request);
      if (path === '/oauth/token') return token(env, request);

      const gallery = /^\/see\/([A-Za-z0-9-]+)$/.exec(path);
      if (gallery?.[1]) {
        return await galleryPage(env, gallery[1], url.searchParams.get('t') ?? '');
      }

      const approval = /^\/approvals\/([A-Za-z0-9-]+)$/.exec(path);
      if (approval?.[1]) {
        return await handleApproval(env, request, url, approval[1]);
      }

      if (path === '/mcp') {
        // Authenticate before the session exists. Identity is passed as props
        // rather than re-derived inside, so a session can never outlive or
        // disagree with the token that opened it.
        const identity = await authenticate(env, request);
        return ForgeMcpSession.serve('/mcp', { binding: 'MCP_SESSIONS' }).fetch(request, env, {
          ...ctx,
          props: { identity }
        } as ExecutionContext & { props: { identity: typeof identity } });
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
              'www-authenticate': `Bearer resource_metadata="${env.FORGE_PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`
            }
          }
        );
      }

      return Response.json(
        { error: forge.code, message: forge.message },
        { status: forge.retryable ? 503 : 400 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
