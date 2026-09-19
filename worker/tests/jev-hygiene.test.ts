import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { classifyHygieneCandidatesWithJev, routeForgeReadEvidenceWithJev } from '../src/jev';

const originalFetch = globalThis.fetch;
const env = {
  TYPESAFE_API_KEY: 'key',
  TYPESAFE_BASE_URL: 'https://api.typesafe.ai/v1/systemone'
} as unknown as Env;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Jev repository hygiene triage', () => {
  it('preserves legacy suspicion and intentional compatibility as different outcomes', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          hygieneKind_0: { type: 'choice', choice: 'legacy/superseded', confidence: 0.94 },
          hygieneInvestigate_0: { type: 'noul', noul: 0.97 },
          hygieneBehavior_0: { type: 'noul', noul: 0.18 },
          hygieneKind_1: { type: 'choice', choice: 'compatibility-intentional', confidence: 0.92 },
          hygieneInvestigate_1: { type: 'noul', noul: 0.31 },
          hygieneBehavior_1: { type: 'noul', noul: 0.96 }
        }
      })
    }) as unknown as typeof fetch;

    const results = await classifyHygieneCandidatesWithJev(env, [
      {
        path: 'src/old-session.ts',
        signals: ['content marker legacy'],
        preview: 'export function oldSession() { return replacedSession(); }'
      },
      {
        path: 'src/compat.ts',
        signals: ['content marker compatibility'],
        preview: 'kept for backwards compatibility with stored v1 records'
      }
    ]);

    expect(results[0]).toMatchObject({
      path: 'src/old-session.ts',
      kind: 'legacy/superseded',
      investigate: 0.97,
      deletionChangesBehavior: 0.18
    });
    expect(results[1]).toMatchObject({
      path: 'src/compat.ts',
      kind: 'compatibility-intentional',
      deletionChangesBehavior: 0.96
    });
  });

  it('routes natural legacy/dead-code questions to hygiene evidence', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          evidenceMode: {
            type: 'choice',
            choice: 'hygiene',
            confidence: 0.95,
            distribution: { hygiene: 0.95, quality: 0.03 }
          },
          shouldRoute: { type: 'noul', noul: 0.97 }
        }
      })
    }) as unknown as typeof fetch;

    await expect(
      routeForgeReadEvidenceWithJev(env, 'can you find old legacy and dead code here?', 'repository')
    ).resolves.toEqual({ mode: 'hygiene', confidence: 0.95 });
  });
});
