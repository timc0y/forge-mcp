import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubRequest } from '../src/contracts';
import type { Env } from '../src/env';
import { auditDurableCommitWithJev } from '../src/post-commit-audit';

const originalFetch = globalThis.fetch;
const repo = { owner: 'o', name: 'r' };

function github(): GitHubRequest {
  return async (path) => {
    if (path.endsWith('/git/commits/newsha')) {
      return {
        status: 200,
        json: { parents: [{ sha: 'parentsha' }] },
        text: '',
        headers: new Headers()
      };
    }
    if (path.endsWith('/compare/parentsha...newsha')) {
      return {
        status: 200,
        json: {
          status: 'ahead', ahead_by: 1, behind_by: 0,
          files: [{
            filename: 'src/auth.ts', status: 'modified', additions: 5, deletions: 1,
            patch: '@@ -1 +1 @@\n-export function oldAuth() {}\n+export function newAuth() {}'
          }]
        },
        text: '',
        headers: new Headers()
      };
    }
    return { status: 404, json: null, text: '', headers: new Headers() };
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('post-commit Jev audit', () => {
  it('audits the actual durable GitHub diff and returns advisory signals', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          primaryArea: { type: 'choice', choice: 'authentication/security', confidence: 0.94 },
          matchesIntent: { type: 'noul', noul: 0.95 },
          breakingChange: { type: 'noul', noul: 0.1 },
          securitySensitive: { type: 'noul', noul: 0.97 },
          persistentDataChange: { type: 'noul', noul: 0.1 },
          userVisible: { type: 'noul', noul: 0.4 },
          testsRelevant: { type: 'noul', noul: 0.7 },
          docsRelevant: { type: 'noul', noul: 0.2 },
          multipleConcerns: { type: 'noul', noul: 0.1 },
          hasOutlier: { type: 'noul', noul: 0.1 }
        }
      })
    }) as unknown as typeof fetch;

    const notices = await auditDurableCommitWithJev(
      { TYPESAFE_API_KEY: 'key' } as unknown as Env,
      github(),
      repo,
      'newsha',
      'tighten authentication',
      ['src/auth.ts']
    );

    expect(notices[0]).toContain('Post-commit Jev audit: Authentication/security');
    expect(notices.some((notice) => notice.includes('security-sensitive'))).toBe(true);
  });

  it('skips docs-only commits without calling Jev', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const notices = await auditDurableCommitWithJev(
      { TYPESAFE_API_KEY: 'key' } as unknown as Env,
      github(),
      repo,
      'newsha',
      'update docs',
      ['docs/guide.md']
    );
    expect(notices).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
