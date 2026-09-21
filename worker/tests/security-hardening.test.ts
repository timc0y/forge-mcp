import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { capture } from '../src/capture';
import { approvalPage } from '../src/approve';
import { ForgeError, toForgeError } from '../src/errors';
import { registerClient, token } from '../src/oauth';
import { githubRequest, installationForLogin, installationRequestFor } from '../src/github';

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureEnv(): Env {
  return {
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_API_TOKEN: 'browser-token'
  } as unknown as Env;
}

describe('GitHub installation token lifetime', () => {
  it('refreshes a long-lived session after one 401 and retries exactly once', async () => {
    const requestedTokens: string[] = [];
    const tokenProvider = vi.fn(async (_env: Env, _installationId: string, forceRefresh = false) =>
      forceRefresh ? 'fresh-token' : 'stale-token'
    );

    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      requestedTokens.push(authorization);
      if (authorization === 'Bearer stale-token') {
        return new Response('{"message":"Bad credentials"}', { status: 401 });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }));

    const request = await githubRequest({} as Env, 'installation-1', tokenProvider);
    const response = await request('/installation/repositories');

    expect(response.status).toBe(200);
    expect(requestedTokens).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
    expect(tokenProvider).toHaveBeenCalledWith({} as Env, 'installation-1', true);
  });

  it('retries one retryable mint failure at connection setup', async () => {
    let attempts = 0;
    const tokenProvider = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ForgeError({
          code: 'FORGE_UPSTREAM_UNAVAILABLE',
          message: 'GitHub declined to issue an installation token (HTTP 503).',
          retryable: true
        });
      }
      return 'token';
    });

    await expect(githubRequest({} as Env, 'installation-1', tokenProvider)).resolves.toBeTypeOf('function');
    expect(attempts).toBe(2);
  });

  it('does not retry a refused installation', async () => {
    let attempts = 0;
    const tokenProvider = vi.fn(async () => {
      attempts += 1;
      throw new ForgeError({
        code: 'FORGE_AUTH_REQUIRED',
        message: 'The Forge GitHub App is not installed for this account.',
        retryable: false
      });
    });

    await expect(githubRequest({} as Env, 'installation-1', tokenProvider)).rejects.toMatchObject({
      code: 'FORGE_AUTH_REQUIRED'
    });
    expect(attempts).toBe(1);
  });

  it('never lets a GitHub read be answered from a cache', async () => {
    const inits: RequestInit[] = [];
    const tokenProvider = vi.fn(async () => 'token');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response('{"ok":true}', { status: 200 });
    }));

    const request = await githubRequest({} as Env, 'installation-1', tokenProvider);
    await request('/repos/o/r/git/ref/heads/forge');

    // GitHub serves reads with s-maxage=60 and a Workers subrequest will use
    // it, so a ref read can return a value from before a delete/recreate.
    expect(inits[0]?.cache).toBe('no-store');
  });

  it('treats the 2026 stateless GitHub App token format as opaque', async () => {
    const stateless = 'ghs_' + 'APPID_JWT_SEGMENT_'.repeat(12);
    const tokenProvider = vi.fn(async () => stateless);
    let authorization = '';
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response('{"ok":true}', { status: 200 });
    }));

    const request = await githubRequest({} as Env, 'installation-1', tokenProvider);
    await request('/installation/repositories');

    expect(authorization).toBe(`Bearer ${stateless}`);
  });

  it('does not retry ordinary GitHub refusals', async () => {
    const tokenProvider = vi.fn(async () => 'token');
    const fetchMock = vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const request = await githubRequest({} as Env, 'installation-1', tokenProvider);
    const response = await request('/repos/o/r');

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('stale installation repair', () => {
  function appKeyEnv(): Env {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
      GITHUB_APP_ID: '4658328',
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    } as unknown as Env;
  }

  it('re-derives a replaced installation and remembers it', async () => {
    const env = appKeyEnv();
    const remembered: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/app/installations?per_page=100')) {
        return Response.json([{ id: 163206430, account: { login: 'timc0y' } }]);
      }
      if (url.endsWith('/app/installations/155142960/access_tokens')) {
        return new Response('{"message":"Not Found"}', { status: 404 });
      }
      if (url.endsWith('/app/installations/163206430/access_tokens')) {
        return Response.json({ token: 'ghs_live', expires_at: '2099-01-01T00:00:00Z' });
      }
      return new Response('{}', { status: 200 });
    }));

    const request = await installationRequestFor(env, '155142960', 'timc0y', async (installationId) => {
      remembered.push(installationId);
    });

    expect(remembered).toEqual(['163206430']);
    expect(typeof request).toBe('function');
  });

  it('asks for the exact installation before walking the App list', async () => {
    const env = appKeyEnv();
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith('/users/timc0y/installation')) return Response.json({ id: 163206430 });
      return new Response('{}', { status: 404 });
    }));

    expect(await installationForLogin(env, 'timc0y')).toBe('163206430');
    expect(seen[0]).toContain('/users/timc0y/installation');
    expect(seen.some((url) => url.includes('/app/installations'))).toBe(false);
  });

  it('falls back to the App list when the exact lookup names nothing', async () => {
    const env = appKeyEnv();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/app/installations?per_page=100')) {
        return Response.json([{ id: 163206430, account: { login: 'timc0y' } }]);
      }
      return new Response('{}', { status: 404 });
    }));

    expect(await installationForLogin(env, 'timc0y')).toBe('163206430');
  });

  it('finds no installation when the App is not installed for that login', async () => {
    const env = appKeyEnv();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 1, account: { login: 'someone-else' } }])));
    expect(await installationForLogin(env, 'timc0y')).toBeNull();
  });

  it('leaves a genuine upstream failure alone instead of treating it as a reinstall', async () => {
    const env = appKeyEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"oops"}', { status: 500 })));

    await expect(
      installationRequestFor(env, '155142960', 'timc0y', async () => {
        throw new Error('must never remember on a non-auth failure');
      })
    ).rejects.toMatchObject({ code: 'FORGE_UPSTREAM_UNAVAILABLE' });
  });
});

describe('public exposure hardening', () => {
  it('renders a duplicated viewport only once and sends redirect guards', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        success: true,
        result: {
          screenshot: btoa('png'),
          accessibilityTree: { role: 'RootWebArea', name: 'Example' }
        },
        meta: { title: 'Example' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await capture(captureEnv(), 'https://example.com/', ['desktop', 'desktop', 'desktop']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.images).toHaveLength(1);
    expect(calls[0]?.rejectRequestPattern).toEqual(expect.arrayContaining([expect.stringContaining('localhost')]));
  });

  it('refuses more than three viewport requests before spending browser time', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      capture(captureEnv(), 'https://example.com/', ['phone', 'tablet', 'desktop', 'desktop'])
    ).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps approval form posts on the current mounted path', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const signingKey = 'test-signing-key-that-is-at-least-32-bytes';
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(signingKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(id))
    );
    let binary = '';
    for (const byte of signature) binary += String.fromCharCode(byte);
    const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const row = {
      id,
      user_id: 'user-1',
      act: 'merge',
      repo_owner: 'octocat',
      repo_name: 'hello-world',
      branch: 'forge/test',
      head_sha: '0123456789abcdef',
      evidence_json: JSON.stringify({
        change: {
          name: 'test',
          branch: 'forge/test',
          number: 1,
          draft: true,
          updatedAt: '2026-08-21T00:00:00.000Z'
        },
        comparison: {
          status: 'ahead',
          aheadBy: 1,
          behindBy: 0,
          files: [],
          truncated: false
        },
        baseBranch: 'main'
      }),
      state: 'pending',
      result_json: null,
      created_at: '2026-08-21T00:00:00.000Z',
      expires_at: '2099-08-21T00:00:00.000Z',
      resolved_at: null
    };
    const metadata = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return row;
              }
            };
          }
        };
      }
    };
    const env = {
      METADATA: metadata,
      FORGE_SIGNING_KEY: signingKey
    } as unknown as Env;

    const response = await approvalPage(env, id, token);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<form method="post" action="?t=');
    expect(html).not.toContain('action="/approvals/');
  });

  it('does not relay unexpected exception text to callers', () => {
    const error = toForgeError(new Error('secret=should-never-be-public'));
    expect(error.message).not.toContain('should-never-be-public');
    expect(error.code).toBe('FORGE_UPSTREAM_UNAVAILABLE');
  });

  it('tells a stale OAuth connection how to recover', async () => {
    const response = await token({} as Env, new Request('https://example.com/forge/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token' })
    }));
    const body = await response.json() as { error?: string; error_description?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toContain('Reconnect Forge');
  });

  it('registers the hosted MCP clients Forge supports', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const env = {
      FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS:
        'chatgpt.com,openai.com,claude.ai,anthropic.com,grok.com,vscode.dev,oauth-redirect.googleusercontent.com,localhost,127.0.0.1',
      METADATA: { prepare: () => ({ bind: () => ({ run }) }) }
    } as unknown as Env;
    const redirectUris = [
      'https://grok.com/connectors-oauth-exchange-code/',
      'https://vscode.dev/redirect',
      'https://oauth-redirect.googleusercontent.com/r/forge'
    ];
    const response = await registerClient(env, new Request('https://example.com/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'hosted clients', redirect_uris: redirectUris })
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ redirect_uris: redirectUris });
    expect(run).toHaveBeenCalledOnce();
  });
});
