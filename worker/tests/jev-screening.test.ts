import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { screenFileContentsWithJev } from '../src/jev';
import { queryContentPreview } from '../src/repository-intelligence';

const originalFetch = globalThis.fetch;
const env = { TYPESAFE_API_KEY: 'key' } as unknown as Env;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('content-first Jev screening', () => {
  it('keeps query-bearing context from late in a large file', () => {
    const content = [
      ...Array.from({ length: 120 }, (_, index) => `const filler${index} = ${index};`),
      'export function rotateRefreshCredential() { return true; }',
      ...Array.from({ length: 120 }, (_, index) => `const tail${index} = ${index};`)
    ].join('\n');

    const preview = queryContentPreview(content, 'refresh credential rotation', 1800);
    expect(preview).toContain('rotateRefreshCredential');
    expect(preview.length).toBeLessThanOrEqual(1800);
  });

  it('returns independent relevance probabilities in input order', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          relevant_0: { type: 'noul', noul: 0.18 },
          relevant_1: { type: 'noul', noul: 0.94 },
          relevant_2: { type: 'noul', noul: 0.71 }
        }
      })
    }) as unknown as typeof fetch;

    const result = await screenFileContentsWithJev(env, 'where is token rotation implemented?', [
      { path: 'src/ui.ts', preview: 'render button' },
      { path: 'src/token.ts', preview: 'rotate refresh token' },
      { path: 'src/session.ts', preview: 'refresh session token' }
    ]);

    expect(result).toEqual([
      { path: 'src/ui.ts', probability: 0.18 },
      { path: 'src/token.ts', probability: 0.94 },
      { path: 'src/session.ts', probability: 0.71 }
    ]);
  });

  it('keeps missing judgments uncertain instead of calling them irrelevant', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ answers: { relevant_0: { type: 'noul', noul: 0.8 } } })
    }) as unknown as typeof fetch;

    const result = await screenFileContentsWithJev(env, 'auth', [
      { path: 'a.ts', preview: 'auth' },
      { path: 'b.ts', preview: 'unknown' }
    ]);

    expect(result[0]?.probability).toBe(0.8);
    expect(result[1]?.probability).toBeNull();
  });
});
