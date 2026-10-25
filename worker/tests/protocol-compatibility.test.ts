import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { authenticate, bindSessionId, issueToken } from '../src/identity';
import { authorize, callback, registerClient, token } from '../src/oauth';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/mcp', () => ({
  SERVER_VERSION: '2.0.0',
  ForgeMcpSession: { serve: () => transport }
}));
import worker from '../src/index';

const origin = 'https://example.test/forge';
const resource = `${origin}/mcp`;
function environment() {
  const prepare = vi.fn(() => ({ bind: (id: string) => ({ first: async () => ({ id, github_login: 'alice', installation_id: '1' }) }) }));
  return { env: { FORGE_PUBLIC_ORIGIN: origin, FORGE_ALLOWED_LOGINS: 'alice', FORGE_SIGNING_KEY: 'test-key-with-at-least-32-bytes', METADATA: { prepare } } as unknown as Env, prepare };
}
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

describe('remote MCP protocol boundaries', () => {
  it('admits the documented Cursor agents callback in local and self-host configurations', async () => {
    const { readFileSync } = await import('node:fs');
    const config = ['wrangler.jsonc', 'wrangler.self-host.example.jsonc'].map(path => readFileSync(path, 'utf8')).join('\n');
    const policies = [...config.matchAll(/"FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS": "([^"]+)"/g)];
    expect(policies).toHaveLength(2);
    for (const policy of policies) expect(policy[1]!.split(',')).toContain('cursor.com');
    const { env } = environment();
    env.FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS = policies[0]![1]!;
    env.METADATA = { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) } as unknown as D1Database;
    const response = await registerClient(env, new Request(`${origin}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://www.cursor.com/agents/mcp/oauth/callback'] }) }));
    expect(response.status).toBe(201);
  });

  it('only permits HTTPS or HTTP loopback OAuth callbacks, without embedded credentials', async () => {
    const { env, prepare } = environment();
    env.FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS = 'localhost,chatgpt.com';
    for (const uri of ['javascript://localhost/callback', 'ftp://localhost/callback', 'http://chatgpt.com/callback', 'https://user:pass@chatgpt.com/callback']) {
      const response = await registerClient(env, new Request(`${origin}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [uri] }) }));
      expect(response.status).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled();
  });
  it('binds signed access tokens to the advertised MCP resource', async () => {
    const { env } = environment();
    const access = await issueToken(env, 'user-a', 3600);
    const request = new Request(resource, { headers: { authorization: `Bearer ${access}` } });
    await expect(authenticate(env, request)).resolves.toMatchObject({ userId: 'user-a' });
    await expect(authenticate({ ...env, FORGE_PUBLIC_ORIGIN: 'https://another.test/forge' }, request)).rejects.toMatchObject({ code: 'FORGE_AUTH_REQUIRED' });
  });

  it('rejects another or duplicated resource before authorization side effects', async () => {
    for (const resources of [['https://another.test/mcp'], [resource, resource]]) {
      const { env, prepare } = environment();
      const params = new URLSearchParams();
      for (const value of resources) params.append('resource', value);
      const response = await authorize(env, new Request(`${origin}/oauth/authorize?${params}`, { method: 'POST' }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_target' });
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it('does not spend a code or refresh token for another resource', async () => {
    const { env, prepare } = environment();
    for (const grant_type of ['authorization_code', 'refresh_token']) {
      const response = await token(env, new Request(`${origin}/oauth/token`, {
        method: 'POST', body: new URLSearchParams({ grant_type, resource: 'https://another.test/mcp' })
      }));
      expect(await response.json()).toMatchObject({ error: 'invalid_target' });
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('accepts browser preflights without authentication or database reads', async () => {
    const { env, prepare } = environment();
    for (const path of ['/mcp', '/oauth/register', '/oauth/token', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await worker.fetch(new Request(`${origin}${path}`, {
        method: 'OPTIONS', headers: { origin: 'https://client.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,mcp-method' }
      }), env, ctx);
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-headers')).toContain('MCP-Method');
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('exposes OAuth discovery challenges to browser clients', async () => {
    const { env } = environment();
    const response = await worker.fetch(new Request(resource), env, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('binds MCP sessions to the authenticated owner for reads, writes and DELETE', async () => {
    const { env } = environment();
    const ownerToken = await issueToken(env, 'user-a', 3600);
    transport.fetch.mockReset().mockResolvedValue(new Response(null, { headers: { 'mcp-session-id': 'internal-session' } }));
    const initial = await worker.fetch(new Request(resource, { method: 'POST', headers: { authorization: `Bearer ${ownerToken}` }, body: '{}' }), env, ctx);
    const publicId = initial.headers.get('mcp-session-id')!;
    expect(publicId).not.toBe('internal-session');
    expect(publicId).toBe(await bindSessionId(env, 'user-a', 'internal-session'));
    const attackerToken = await issueToken(env, 'user-b', 3600);
    for (const method of ['GET', 'POST', 'DELETE']) {
      transport.fetch.mockClear();
      const rejected = await worker.fetch(new Request(resource, { method, headers: { authorization: `Bearer ${attackerToken}`, 'mcp-session-id': publicId } }), env, ctx);
      expect(rejected.status).toBe(404);
      expect(transport.fetch).not.toHaveBeenCalled();
      await worker.fetch(new Request(resource, { method, headers: { authorization: `Bearer ${ownerToken}`, 'mcp-session-id': publicId } }), env, ctx);
      expect(transport.fetch.mock.calls[0]![0].headers.get('mcp-session-id')).toBe('internal-session');
    }
  });

  it('returns CORS-readable failures when the MCP transport rejects', async () => {
    const { env } = environment();
    transport.fetch.mockRejectedValueOnce(new Error('synthetic upstream outage'));
    const response = await worker.fetch(new Request(resource, { method: 'POST', headers: { authorization: `Bearer ${await issueToken(env, 'user-a', 60)}`, origin: 'https://client.test' }, body: '{}' }), env, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toMatchObject({ error: 'FORGE_UPSTREAM_UNAVAILABLE' });
  });

  it('handles rejected OAuth operations inside the router error boundary', async () => {
    const { env } = environment();
    env.FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS = 'chatgpt.com';
    env.METADATA = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('synthetic D1 outage'); } }) }) } as unknown as D1Database;
    const response = await worker.fetch(new Request(`${origin}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://chatgpt.com/callback'] }) }), env, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toMatchObject({ error: 'FORGE_UPSTREAM_UNAVAILABLE' });
  });

  it('refuses a copied GitHub callback in a different browser before exchanging a code', async () => {
    const { env } = environment();
    const client = { client_id: 'client-a', client_name: 'client', redirect_uris: JSON.stringify(['https://chatgpt.com/callback']) };
    env.FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS = 'chatgpt.com';
    env.GITHUB_APP_CLIENT_ID = 'app-test';
    env.METADATA = { prepare: () => ({ bind: () => ({ first: async () => client }) }) } as unknown as D1Database;
    const params = new URLSearchParams({ client_id: 'client-a', redirect_uri: 'https://chatgpt.com/callback', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource });
    const consent = await authorize(env, new Request(`${origin}/oauth/authorize?${params}`, { method: 'POST' }));
    const cookie = consent.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    const state = new URL(consent.headers.get('location')!).searchParams.get('state')!;
    const callbackUrl = `${origin}/oauth/callback?${new URLSearchParams({ state, code: 'github-single-use-code' })}`;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'bad_code' }));
    try {
      for (const headers of [new Headers(), new Headers({ cookie: 'forge-oauth-state=another-browser' })]) {
        const rejected = await callback(env, new Request(callbackUrl, { headers }));
        expect(rejected.status).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
      }
      const bound = await callback(env, new Request(callbackUrl, { headers: { cookie: cookie.split(';')[0]! } }));
      expect(bound.status).toBe(502);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
