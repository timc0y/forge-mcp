import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { routeForgeReadEvidenceWithJev } from '../src/jev';

const originalFetch = globalThis.fetch;
const env = {
  TYPESAFE_API_KEY: 'key',
  TYPESAFE_BASE_URL: 'https://api.typesafe.ai/v1/systemone'
} as unknown as Env;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Forge read evidence routing', () => {
  it('skips Jev entirely for ordinary code-navigation questions', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const route = await routeForgeReadEvidenceWithJev(env, 'where is token rotation implemented?', 'repository');
    expect(route).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('routes a natural merge-protection question to policy evidence', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          evidenceMode: {
            type: 'choice',
            choice: 'policy',
            confidence: 0.91,
            distribution: { policy: 0.91, quality: 0.06 }
          },
          shouldRoute: { type: 'noul', noul: 0.96 }
        }
      })
    }) as unknown as typeof fetch;

    const route = await routeForgeReadEvidenceWithJev(env, 'what checks and rules protect merges here?', 'repository');
    expect(route).toEqual({ mode: 'policy', confidence: 0.91 });
  });

  it('abstains when specialized evidence is not clearly the right answer', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          evidenceMode: { type: 'choice', choice: 'review', confidence: 0.8 },
          shouldRoute: { type: 'noul', noul: 0.4 }
        }
      })
    }) as unknown as typeof fetch;

    const route = await routeForgeReadEvidenceWithJev(env, 'is this change safe?', 'change');
    expect(route).toBeNull();
  });
});
