import { describe, expect, it } from 'vitest';
import { repositoryAccessDiagnosis } from '../../apps/forge-edge-gateway/src/github';
import type { Env } from '../../apps/forge-edge-gateway/src/env';

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
