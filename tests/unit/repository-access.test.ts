import { describe, expect, it } from 'vitest';
import { repositoryAccessDiagnosis, repositoryCloneSource } from '../../apps/forge-edge-gateway/src/github';
import type { Env } from '../../apps/forge-edge-gateway/src/env';
import type { Workspace } from '@forge/core';

// An empty repository list reads as "Forge is broken" unless it says otherwise,
// and the reasons behind it need completely different actions. Naming the wrong
// one sends the owner to the wrong fix, which is worse than saying nothing.

function envWith(installation: { status: string; account_login: string } | null, login = 'octocat') {
  return {
    FORGE_PUBLIC_ORIGIN: 'https://forge.test',
    METADATA: {
      prepare(sql: string) {
        const statement: Record<string, unknown> = {
          bind: () => statement,
          first: async () => {
            if (sql.includes('FROM github_installations')) return installation;
            if (sql.includes('FROM users')) return { github_login: login };
            return null;
          }
        };
        return statement;
      }
    }
  } as unknown as Env;
}

describe('why there are no repositories', () => {
  it('distinguishes never installed from revoked', async () => {
    expect(await repositoryAccessDiagnosis(envWith(null), 'ten_a')).toMatchObject({ state: 'never_installed' });
    expect(await repositoryAccessDiagnosis(envWith({ status: 'revoked', account_login: 'octocat' }), 'ten_a'))
      .toMatchObject({ state: 'revoked' });
  });

  it('spots the account rename that produced this in production', async () => {
    // The real case: the installation still says the old login, the user row has
    // the new one, and every repository is stranded under the old owner.
    const result = await repositoryAccessDiagnosis(
      envWith({ status: 'active', account_login: 'timcoy47' }, 'timc0y'),
      'ten_a'
    );
    expect(result.state).toBe('stale_owner');
    expect(result.detail).toContain('timcoy47');
    expect(result.detail).toContain('timc0y');
  });

  it('always points at somewhere the owner can actually click', async () => {
    for (const installation of [null, { status: 'revoked', account_login: 'a' }, { status: 'active', account_login: 'octocat' }]) {
      const result = await repositoryAccessDiagnosis(envWith(installation), 'ten_a');
      expect(result.installUrl).toBe('https://forge.test/github/install');
      expect(result.detail.length).toBeGreaterThan(20);
    }
  });

  it('does not cry rename when the names agree', async () => {
    expect(await repositoryAccessDiagnosis(envWith({ status: 'active', account_login: 'octocat' }, 'octocat'), 'ten_a'))
      .toMatchObject({ state: 'ok' });
  });
});

describe('workspace clone source', () => {
  const workspace = {
    id: 'ws_0123456789abcdefghjkmnpq',
    tenantId: 'ten_test',
    projectId: 'prj_test',
    repository: { provider: 'github', owner: 'octocat', name: 'hello-world' },
    createdBy: { type: 'agent', id: 'agent-test' }
  } as unknown as Workspace;

  function cloneEnv(repositoryRow: Record<string, unknown> | null): Env {
    return {
      FORGE_PUBLIC_ORIGIN: 'https://forge.test',
      FORGE_CAPABILITY_SIGNING_KEY: 'test-key-with-at-least-32-bytes-for-hmac',
      METADATA: {
        prepare(sql: string) {
          const statement: Record<string, unknown> = {
            bind: () => statement,
            first: async () => sql.includes('FROM repositories') ? repositoryRow : null
          };
          return statement;
        }
      }
    } as unknown as Env;
  }

  it('uses an authorized D1 installation row for the private clone proxy', async () => {
    const source = await repositoryCloneSource(cloneEnv({
      installation_id: '42',
      authorization_state: 'authorized'
    }), workspace);

    expect(source.url).toBe('https://forge.test/git/ws_0123456789abcdefghjkmnpq/octocat/hello-world.git');
    expect(source.authorizationHeader).toMatch(/^Authorization: Bearer /u);
  });

  it('falls back to the public git URL without probing GitHub when no installation row exists', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('public API probe must not run during provisioning'); };
    try {
      await expect(repositoryCloneSource(cloneEnv(null), workspace)).resolves.toEqual({
        url: 'https://github.com/octocat/hello-world.git'
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
