import { describe, expect, it } from 'vitest';
import { authorize } from '../../apps/forge-edge-gateway/src/oauth';
import type { Env } from '../../apps/forge-edge-gateway/src/env';

function metadata() {
  const inserted: unknown[][] = [];
  return {
    inserted,
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...input: unknown[]) {
          values = input;
          return this;
        },
        async first<T>() {
          if (sql.includes('FROM oauth_clients')) {
            return {
              client_id: 'client_test',
              client_name: 'Acceptance test',
              redirect_uris: JSON.stringify(['http://127.0.0.1/callback'])
            } as T;
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO oauth_codes')) inserted.push(values);
          return { success: true };
        }
      };
    }
  };
}

describe('OAuth authorization', () => {
  it('accepts the owner token when GitHub sign-in is enabled', async () => {
    const store = metadata();
    const env = {
      METADATA: store,
      FORGE_PUBLIC_ORIGIN: 'https://forge.example',
      FORGE_DEFAULT_TENANT_ID: 'ten_owner',
      FORGE_DEFAULT_PROJECT_ID: 'prj_owner',
      FORGE_OWNER_AUTH_TOKEN: 'owner-secret',
      GITHUB_APP_CLIENT_ID: 'github-client',
      GITHUB_APP_CLIENT_SECRET: 'github-secret'
    } as unknown as Env;
    const query = new URLSearchParams({
      client_id: 'client_test',
      redirect_uri: 'http://127.0.0.1/callback',
      response_type: 'code',
      scope: 'forge:workspace',
      state: 'state_test',
      code_challenge: 'challenge',
      code_challenge_method: 'S256'
    });
    const request = new Request(`https://forge.example/oauth/authorize?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'owner-secret' })
    });

    const response = await authorize(request, env);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe('http://127.0.0.1');
    expect(location.searchParams.get('code')).toMatch(/^code_/u);
    expect(location.searchParams.get('state')).toBe('state_test');
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]?.[5]).toBe('owner-user');
  });
});
