import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { allowedLogins, isLoginAllowed } from '../src/access';
import { authenticate, identityForUser, issueRefreshToken, issueToken } from '../src/identity';
import { authorize, callback, registerClient, token } from '../src/oauth';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/mcp', () => ({ SERVER_VERSION: 'test', ForgeMcpSession: { serve: () => transport } }));
import worker from '../src/index';

const origin = 'https://forge.operator.test';
const redirect = 'https://chatgpt.com/callback';
const verifier = 'v'.repeat(43);
const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
  vi.restoreAllMocks();
  transport.fetch.mockReset();
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  openDatabases.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  db.prepare('INSERT INTO oauth_clients VALUES (?, ?, ?, ?)').run('client', 'Test client', JSON.stringify([redirect]), new Date().toISOString());
  const env = {
    FORGE_ENVIRONMENT: 'production',
    FORGE_PUBLIC_ORIGIN: origin,
    FORGE_ALLOWED_LOGINS: 'operator',
    FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS: 'chatgpt.com',
    FORGE_SIGNING_KEY: 'synthetic-test-signing-key-with-32-bytes',
    GITHUB_APP_CLIENT_ID: 'synthetic-app',
    GITHUB_APP_CLIENT_SECRET: 'synthetic-client-secret',
    METADATA: {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        return { first: async () => statement.get() ?? null, bind(...values: SQLInputValue[]) { return {
          first: async () => statement.get(...values) ?? null,
          run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } })
        }; } };
      }
    }
  } as unknown as Env;
  function addUser(id = 'operator-id', login = 'operator') {
    db.prepare('INSERT INTO users (id, github_user_id, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, id, login, new Date().toISOString(), new Date().toISOString());
  }
  return { db, env, addUser };
}

async function challenge() {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
}

async function beginSignIn(env: Env) {
  const params = new URLSearchParams({ client_id: 'client', redirect_uri: redirect, response_type: 'code', code_challenge: await challenge(), code_challenge_method: 'S256' });
  const response = await authorize(env, new Request(`${origin}/oauth/authorize?${params}`, { method: 'POST' }));
  expect(response.status).toBe(302);
  const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
  return new Request(`${origin}/oauth/callback?${new URLSearchParams({ state, code: 'synthetic-github-code' })}`, {
    headers: { cookie: response.headers.get('set-cookie')!.split(';')[0]! }
  });
}

function tokenRequest(body: Record<string, string>) {
  return new Request(`${origin}/oauth/token`, { method: 'POST', body: new URLSearchParams(body) });
}

describe('explicit private instance access', () => {
  it.each([undefined, null, '', ' ', '*', 'operator,', ',operator', 'operator,,another', 'operator,bad_login', 'operator,K', 'K', '-operator', 'operator-', 'two--hyphens', 'a'.repeat(40), ['operator']])('denies all access for malformed or absent configuration %j', value => {
    const env = { FORGE_ALLOWED_LOGINS: value } as unknown as Env;
    expect(allowedLogins(env)).toEqual([]);
    expect(isLoginAllowed(env, 'operator')).toBe(false);
  });

  it('matches complete GitHub logins without case sensitivity', () => {
    const env = { FORGE_ALLOWED_LOGINS: ' Operator, Second-Person ' };
    expect(isLoginAllowed(env, 'OPERATOR')).toBe(true);
    expect(isLoginAllowed(env, 'second-person')).toBe(true);
    for (const login of ['other', 'operator-extra', ' operator', '']) expect(isLoginAllowed(env, login)).toBe(false);
  });

  it('rechecks the current login and configuration for an existing bearer', async () => {
    const { env, db, addUser } = fixture();
    addUser();
    const request = new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${await issueToken(env, 'operator-id', 3600)}` } });
    await expect(authenticate(env, request)).resolves.toEqual({ userId: 'operator-id', githubLogin: 'operator' });
    env.FORGE_ALLOWED_LOGINS = 'another';
    await expect(authenticate(env, request)).rejects.toMatchObject({ code: 'FORGE_AUTH_REQUIRED' });
    env.FORGE_ALLOWED_LOGINS = 'operator';
    db.prepare('UPDATE users SET github_login = ? WHERE id = ?').run('renamed', 'operator-id');
    await expect(authenticate(env, request)).rejects.toMatchObject({ code: 'FORGE_AUTH_REQUIRED' });
    env.FORGE_ALLOWED_LOGINS = 'renamed';
    await expect(identityForUser(env, 'operator-id')).resolves.toMatchObject({ githubLogin: 'renamed' });
    db.prepare('DELETE FROM users WHERE id = ?').run('operator-id');
    await expect(authenticate(env, request)).rejects.toMatchObject({ code: 'FORGE_AUTH_REQUIRED' });
  });

  it.each(['local', 'development'] as const)('keeps %s bearer usable only for an allowed seeded account', async environment => {
    const { env, addUser } = fixture();
    addUser();
    env.FORGE_ENVIRONMENT = environment;
    env.FORGE_DEV_AUTH_TOKEN = 'synthetic-dev-bearer';
    const request = new Request(`${origin}/mcp`, { headers: { authorization: 'Bearer synthetic-dev-bearer' } });
    await expect(authenticate(env, request)).resolves.toMatchObject({ userId: 'operator-id' });
    env.FORGE_ALLOWED_LOGINS = '';
    await expect(authenticate(env, request)).rejects.toMatchObject({ code: 'FORGE_AUTH_REQUIRED' });
    env.FORGE_ALLOWED_LOGINS = 'someone-else';
    await expect(authenticate(env, request)).rejects.toMatchObject({ code: 'FORGE_AUTH_REQUIRED' });
    env.FORGE_ENVIRONMENT = 'production';
    env.FORGE_ALLOWED_LOGINS = 'operator';
    await expect(authenticate(env, request)).rejects.toMatchObject({ code: 'FORGE_AUTH_REQUIRED' });
  });

  it('rejects an existing denied connection before the MCP transport or any provider work', async () => {
    const { env, addUser } = fixture();
    addUser('denied-id', 'other');
    const accessToken = await issueToken(env, 'denied-id', 3600);
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider work'));
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await worker.fetch(new Request(`${origin}/mcp`, { method, headers: { authorization: `Bearer ${accessToken}`, 'mcp-session-id': 'existing-session' } }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'FORGE_AUTH_REQUIRED' });
    }
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});

describe('OAuth private access', () => {
  it('leaves client registration available without granting user access', async () => {
    const { env, db } = fixture();
    env.FORGE_ALLOWED_LOGINS = '';
    const response = await registerClient(env, new Request(`${origin}/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [redirect] }) }));
    expect(response.status).toBe(201);
    expect(db.prepare('SELECT count(*) AS n FROM users').get()?.n).toBe(0);
  });

  it('bounds registration bytes before any database work, even with a false length', async () => {
    const { env } = fixture();
    const prepare = vi.spyOn(env.METADATA, 'prepare');
    for (const headers of [new Headers(), new Headers({ 'content-length': '1' })]) {
      const response = await registerClient(env, new Request(`${origin}/oauth/register`, {
        method: 'POST', headers, body: JSON.stringify({ redirect_uris: [redirect], extra: 'x'.repeat(16384) })
      }));
      expect(response.status).toBe(413);
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('admits only the remaining hourly slot under concurrent registration and leaves existing clients intact', async () => {
    const { env, db } = fixture();
    const insert = db.prepare('INSERT INTO oauth_clients VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 28; i++) insert.run(`existing-${i}`, 'Client', JSON.stringify([redirect]), new Date().toISOString());
    const requests = Array.from({ length: 8 }, () => registerClient(env, new Request(`${origin}/oauth/register`, {
      method: 'POST', body: JSON.stringify({ redirect_uris: [redirect] })
    })));
    const responses = await Promise.all(requests);
    expect(responses.filter(r => r.status === 201)).toHaveLength(1);
    expect(responses.filter(r => r.status === 429)).toHaveLength(7);
    expect(db.prepare('SELECT count(*) AS n FROM oauth_clients').get()?.n).toBe(30);
    expect(db.prepare('SELECT client_id FROM oauth_clients WHERE client_id = ?').get('client')).toBeTruthy();
    db.exec("UPDATE oauth_clients SET created_at = '2020-01-01T00:00:00.000Z'");
    expect((await registerClient(env, new Request(`${origin}/oauth/register`, {
      method: 'POST', body: JSON.stringify({ redirect_uris: [redirect] })
    }))).status).toBe(201);
  });

  it('bounds retained clients even when the hourly allowance is free', async () => {
    const { env, db } = fixture();
    const insert = db.prepare('INSERT INTO oauth_clients VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 999; i++) insert.run(`old-${i}`, 'Client', JSON.stringify([redirect]), '2020-01-01T00:00:00.000Z');
    const response = await registerClient(env, new Request(`${origin}/oauth/register`, {
      method: 'POST', body: JSON.stringify({ redirect_uris: [redirect] })
    }));
    expect(response.status).toBe(429);
    expect(db.prepare('SELECT count(*) AS n FROM oauth_clients').get()?.n).toBe(1000);
  });

  it('refuses blank configuration before GitHub or account writes, even for an in-flight sign-in', async () => {
    const { env, db } = fixture();
    const request = await beginSignIn(env);
    env.FORGE_ALLOWED_LOGINS = '';
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider work'));
    expect((await authorize(env, new Request(`${origin}/oauth/authorize`))).status).toBe(403);
    expect((await callback(env, request)).status).toBe(403);
    expect(network).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) AS n FROM users').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM oauth_codes').get()?.n).toBe(0);
  });

  it.each([false, true])('denies an unlisted GitHub callback before changing account state (existing=%s)', async existing => {
    const { env, db, addUser } = fixture();
    if (existing) addUser('123', 'other');
    const request = await beginSignIn(env);
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'synthetic-upstream-token' });
      expect(String(input)).toBe('https://api.github.com/user');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-upstream-token');
      return Response.json({ id: 123, login: 'other' });
    });
    const before = db.prepare('SELECT * FROM users').all();
    const response = await callback(env, request);
    expect(response.status).toBe(403);
    expect(db.prepare('SELECT * FROM users').all()).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM oauth_codes').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM oauth_refresh_tokens').get()?.n).toBe(0);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('keeps the allowed operator GitHub sign-in and both token grants usable', async () => {
    const { env, db } = fixture();
    env.FORGE_ALLOWED_LOGINS = 'OPERATOR';
    const request = await beginSignIn(env);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input) === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'synthetic-upstream-token', refresh_token: 'synthetic-upstream-refresh', expires_in: 28800 });
      expect(String(input)).toBe('https://api.github.com/user');
      return Response.json({ id: 123, login: 'operator' });
    });
    const response = await callback(env, request);
    expect(response.status).toBe(302);
    const stored = db.prepare('SELECT github_token FROM users').get()?.github_token;
    expect(typeof stored).toBe('string');
    expect(stored).not.toBe('synthetic-upstream-token');
    const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
    const grant = await token(env, tokenRequest({ grant_type: 'authorization_code', code, client_id: 'client', redirect_uri: redirect, code_verifier: verifier }));
    expect(grant.status).toBe(200);
    const credentials = await grant.json() as { access_token: string; refresh_token: string };
    await expect(authenticate(env, new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${credentials.access_token}` } }))).resolves.toMatchObject({ githubLogin: 'operator' });
    const refresh = await token(env, tokenRequest({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token, client_id: 'client' }));
    expect(refresh.status).toBe(200);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each(['configuration', 'stored login'] as const)('refuses an outstanding code and refresh grant after access changes through %s', async change => {
    const { env, db, addUser } = fixture();
    addUser();
    const refreshToken = await issueRefreshToken(env, 'operator-id', 'client');
    const codeHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('synthetic-code'))).toString('base64url');
    db.prepare('INSERT INTO oauth_codes VALUES (?, ?, ?, ?, ?, ?, NULL)').run(codeHash, 'client', redirect, await challenge(), 'operator-id', new Date(Date.now() + 60000).toISOString());
    if (change === 'configuration') env.FORGE_ALLOWED_LOGINS = 'different';
    else db.prepare('UPDATE users SET github_login = ?').run('different');
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider work'));
    const grants: Record<string, string>[] = [
      { grant_type: 'authorization_code', code: 'synthetic-code', client_id: 'client', redirect_uri: redirect, code_verifier: verifier },
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'client' }
    ];
    for (const body of grants) {
      const response = await token(env, tokenRequest(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
    }
    expect(db.prepare('SELECT used_at FROM oauth_codes').get()?.used_at).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM oauth_refresh_tokens').get()?.n).toBe(1);
    expect(db.prepare('SELECT used_at FROM oauth_refresh_tokens').get()?.used_at).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });
});
