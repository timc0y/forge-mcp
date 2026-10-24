import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { authenticate, issueRefreshToken, issueToken, rotateRefreshToken } from '../src/identity';

const bindings = vi.hoisted(() => ({ register: vi.fn(), user: vi.fn(), approval: vi.fn() }));
vi.mock('agents/mcp', () => ({ McpAgent: class {} }));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {} }));
vi.mock('../src/tool-catalog', () => ({ registerTools: bindings.register }));
vi.mock('../src/user-token', () => ({ userRequestFor: bindings.user }));
vi.mock('../src/approve', () => ({ approvalPage: vi.fn(), resolveApproval: bindings.approval }));
import { ForgeMcpSession } from '../src/mcp';
import worker from '../src/index';

afterEach(() => { vi.restoreAllMocks(); bindings.register.mockReset(); bindings.user.mockReset(); bindings.approval.mockReset(); });

function refreshEnvironment() {
  const rows = new Map<string, Record<string, any>>();
  let beforeInsert: (() => Promise<void>) | undefined;
  const env = { FORGE_SIGNING_KEY: 'synthetic-test-key', FORGE_ALLOWED_LOGINS: 'alice', METADATA: { prepare(sql: string) {
    return { bind(...v: any[]) { return {
      async first() { const row = rows.get(v[0]); return row ? { ...row, github_login: 'alice' } : null; },
      async run() {
        if (sql.includes('INSERT INTO oauth_refresh_tokens')) {
          await beforeInsert?.();
          // Mirrors the production INSERT SELECT predicate, including its atomicity.
          expect(sql).toContain('WHERE NOT EXISTS');
          if ([...rows.values()].some(r => r.family_id === v[1] && r.revoked_at)) return { meta: { changes: 0 } };
          rows.set(v[0], { family_id: v[1], user_id: v[2], client_id: v[3], key_tag: v[4], expires_at: v[5], used_at: null, revoked_at: null });
          return { meta: { changes: 1 } };
        }
        if (sql.includes('SET used_at')) {
          const row = rows.get(v[1]);
          if (!row || row.used_at || row.revoked_at) return { meta: { changes: 0 } };
          row.used_at = v[0]; return { meta: { changes: 1 } };
        }
        if (sql.includes('SET revoked_at')) {
          for (const row of rows.values()) if (row.family_id === v[1]) row.revoked_at = v[0];
          return { meta: { changes: 1 } };
        }
        throw Error('Unexpected SQL');
      }
    }; } };
  } } } as unknown as Env;
  return { env, beforeInsert: (hook: () => Promise<void>) => { beforeInsert = hook; } };
}

describe('human authorization and refresh replay', () => {
  it('authenticates an existing connection without a cached installation', async () => {
    const env = { FORGE_SIGNING_KEY: 'synthetic-test-key', FORGE_ALLOWED_LOGINS: 'alice', FORGE_PUBLIC_ORIGIN: 'https://example.test/forge', METADATA: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'alice', github_login: 'alice', installation_id: null }) }) }) } } as unknown as Env;
    await expect(authenticate(env, new Request('https://example.test/forge/mcp', { headers: { authorization: `Bearer ${await issueToken(env, 'alice', 60)}` } }))).resolves.toEqual({ userId: 'alice', githubLogin: 'alice' });
  });

  it('resolves the human credential for each repository request instead of minting an App token', async () => {
    const env = { FORGE_ALLOWED_LOGINS: 'alice', METADATA: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'alice', github_login: 'alice' }) }) }) } } as unknown as Env;
    const session = new ForgeMcpSession({} as DurableObjectState, env);
    Object.assign(session, { env, props: { identity: { userId: 'alice', githubLogin: 'alice', installationId: 'org-installation' } }, ctx: { waitUntil: vi.fn() } });
    const denied = vi.fn(async () => ({ status: 403, json: null, text: 'Forbidden', headers: new Headers() }));
    bindings.user.mockResolvedValue(denied);
    await session.init();
    const context = bindings.register.mock.calls[0]![1];
    expect(bindings.user).not.toHaveBeenCalled();
    await expect(context.gh('/repos/org/secret', { method: 'PATCH' })).resolves.toMatchObject({ status: 403 });
    await context.gh('/repos/org/secret');
    expect(bindings.user).toHaveBeenCalledTimes(2);
    expect(bindings.user).toHaveBeenCalledWith(env, 'alice');
  });

  it('executes an approval using its stored human owner, never installation-wide credentials', async () => {
    const env = { FORGE_PUBLIC_ORIGIN: 'https://example.test/forge', FORGE_ALLOWED_LOGINS: 'alice', METADATA: { prepare: () => ({ bind: () => ({ first: async () => ({ id: 'approval-owner', user_id: 'approval-owner', github_login: 'alice' }) }) }) } } as unknown as Env;
    const denied = vi.fn(async () => ({ status: 403, json: null, text: 'Forbidden', headers: new Headers() }));
    bindings.user.mockResolvedValue(denied);
    bindings.approval.mockImplementation(async (_env, _id, _token, _decision, gh) => Response.json(await gh('/repos/org/secret', { method: 'DELETE' })));
    const response = await worker.fetch(new Request('https://example.test/forge/approvals/approval-1?t=signed', { method: 'POST', body: new URLSearchParams({ decision: 'approve' }) }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
    expect(await response.json()).toMatchObject({ status: 403 });
    expect(bindings.user).toHaveBeenCalledWith(env, 'approval-owner');
  });

  it('does not issue a replacement after replay revokes the family before insertion', async () => {
    const { env, beforeInsert } = refreshEnvironment();
    const original = await issueRefreshToken(env, 'alice', 'client');
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    beforeInsert(async () => { entered(); await releasePromise; });
    const rotating = rotateRefreshToken(env, original, 'client');
    await enteredPromise;
    expect(await rotateRefreshToken(env, original, 'client')).toBeNull();
    release();
    expect(await rotating).toBeNull();
  });

  it('revokes a replacement when replay happens after insertion and preserves client binding', async () => {
    const { env } = refreshEnvironment();
    const original = await issueRefreshToken(env, 'alice', 'client');
    expect(await rotateRefreshToken(env, original, 'other-client')).toBeNull();
    const rotated = await rotateRefreshToken(env, original, 'client');
    expect(rotated).not.toBeNull();
    expect(await rotateRefreshToken(env, original, 'client')).toBeNull();
    expect(await rotateRefreshToken(env, rotated!.refreshToken, 'client')).toBeNull();
  });
});

describe('distributed GitHub credential refresh', () => {
  async function credentials() {
    const actual = await vi.importActual<typeof import('../src/user-token')>('../src/user-token');
    const row: Record<string, any> = { github_token: null, github_refresh_token: null, github_token_expires_at: null };
    const env = { FORGE_SIGNING_KEY: 'synthetic-test-key', METADATA: { prepare(sql: string) { return { bind(...v: any[]) { return {
      async first() { return { ...row }; },
      async run() {
        if (sql.includes('SET github_refresh_token = NULL')) {
          if (row.github_token !== v[1] || row.github_refresh_token !== v[2]) return { meta: { changes: 0 } };
          row.github_refresh_token = null; return { meta: { changes: 1 } };
        }
        if (v[5] !== null && (row.github_token !== v[5] || row.github_refresh_token !== null)) return { meta: { changes: 0 } };
        row.github_token = v[1]; row.github_refresh_token = v[2]; row.github_token_expires_at = v[3];
        return { meta: { changes: 1 } };
      }
    }; } }; } } } as unknown as Env;
    await actual.storeUserCredential(env, 'alice', { token: 'old-user-token', refreshToken: 'old-refresh', expiresInSeconds: -1 });
    return { env, actual, row };
  }

  it('spends one rotating GitHub credential once across simultaneous request handlers', async () => {
    const { env, actual } = await credentials();
    let exchanges = 0;
    const authorizations: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/login/oauth/access_token')) {
        exchanges += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return Response.json({ access_token: 'new-user-token', refresh_token: 'new-refresh', expires_in: 28800 });
      }
      authorizations.push(new Headers(init?.headers).get('authorization')!);
      return Response.json({ ok: true });
    }));
    try {
      const handlers = await Promise.all(Array.from({ length: 4 }, () => actual.userRequestFor(env, 'alice')));
      await Promise.all(handlers.map(gh => gh('/repos/org/repo')));
      expect(exchanges).toBe(1);
      expect(authorizations).toEqual(Array(4).fill('Bearer new-user-token'));
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not overwrite a newer GitHub sign-in with an older in-flight refresh', async () => {
    const { env, actual } = await credentials();
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    let authorization: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/login/oauth/access_token')) {
        entered(); await releasePromise;
        return Response.json({ access_token: 'stale-refresh-result', refresh_token: 'stale-next-refresh', expires_in: 28800 });
      }
      authorization = new Headers(init?.headers).get('authorization');
      return Response.json({ ok: true });
    }));
    try {
      const pending = actual.userRequestFor(env, 'alice');
      await enteredPromise;
      await actual.storeUserCredential(env, 'alice', { token: 'new-sign-in', refreshToken: 'new-sign-in-refresh', expiresInSeconds: 28800 });
      release();
      await (await pending)('/repos/org/repo');
      expect(authorization).toBe('Bearer new-sign-in');
    } finally { vi.unstubAllGlobals(); }
  });
});
