import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { parsePathRange, readFiles } from '../src/read';
import { semanticFileExcerpt, semanticPathTriage, typesafeSystemOne } from '../src/jev';
import type { GitHubRequest } from '../src/contracts';
import type { Env } from '../src/env';

function fakeGitHub(routes: Record<string, { status: number; json?: unknown; text?: string }>): GitHubRequest {
  return async (path, init) => {
    const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`;
    const hit = routes[key] ?? routes[path.split('?')[0] ?? ''];
    if (!hit) return { status: 404, json: null, text: '', headers: new Headers() };
    return {
      status: hit.status,
      json: hit.json ?? null,
      text: hit.text ?? JSON.stringify(hit.json ?? null),
      headers: new Headers()
    };
  };
}

describe('parsePathRange', () => {
  it('parses standard paths without ranges', () => {
    const parsed = parsePathRange('src/index.ts');
    expect(parsed.cleanPath).toBe('src/index.ts');
    expect(parsed.raw).toBe('src/index.ts');
    expect(parsed.startLine).toBeUndefined();
    expect(parsed.endLine).toBeUndefined();
  });

  it('parses line ranges like path:start-end', () => {
    const parsed = parsePathRange('src/components/button.tsx:10-50');
    expect(parsed.cleanPath).toBe('src/components/button.tsx');
    expect(parsed.startLine).toBe(10);
    expect(parsed.endLine).toBe(50);
  });

  it('parses single line start offsets like path:100', () => {
    const parsed = parsePathRange('src/server.ts:100');
    expect(parsed.cleanPath).toBe('src/server.ts');
    expect(parsed.startLine).toBe(100);
    expect(parsed.endLine).toBeUndefined();
  });
});

describe('readFiles line-range and pagination', () => {
  const multiline = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const multilineFile = {
    'GET /repos/o/r/contents/lines.txt': {
      status: 200,
      json: { type: 'file', encoding: 'base64', content: btoa(multiline), size: multiline.length }
    }
  };

  it('extracts a requested line range with exact bounds', async () => {
    const request = fakeGitHub(multilineFile);
    const result = await readFiles(request, { owner: 'o', name: 'r' }, 'main', ['lines.txt:5-8'], 100_000);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('lines.txt:5-8');
    expect(result.files[0]?.content).toBe('line 5\nline 6\nline 7\nline 8');
    expect(result.files[0]?.truncated).toBe(true);
  });

  it('paginates oversized files rather than dropping them completely', async () => {
    const longContent = Array.from({ length: 600 }, (_, i) => `statement_${i + 1}();`).join('\n');
    const request = fakeGitHub({
      'GET /repos/o/r/contents/big.js': {
        status: 200,
        json: { type: 'file', encoding: 'base64', content: btoa(longContent), size: longContent.length }
      }
    });

    // Budget smaller than total file size (e.g. 5000 bytes)
    const result = await readFiles(request, { owner: 'o', name: 'r' }, 'main', ['big.js'], 5000);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.truncated).toBe(true);
    // Returns lines 1-400
    expect(result.files[0]?.content.split('\n')).toHaveLength(400);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain('Pass \'big.js:401-600\' for next window');
  });
});

describe('TypeSafe Jev System One client', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null gracefully when API key is not configured', async () => {
    const result = await typesafeSystemOne(undefined, undefined, {
      state: {},
      questions: {}
    });
    expect(result).toBeNull();
  });

  it('posts typed questions and parses System One answers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          choiceQ: {
            type: 'choice',
            choice: 'src/auth.ts',
            confidence: 0.92,
            distribution: { 'src/auth.ts': 0.85, 'src/index.ts': 0.15 }
          }
        }
      })
    }) as unknown as typeof fetch;

    const result = await typesafeSystemOne('jev_test_key', undefined, {
      state: { query: 'login' },
      questions: {
        choiceQ: {
          type: 'choice',
          instructions: 'Pick matching file',
          criteria: ['src/auth.ts', 'src/index.ts']
        }
      }
    });

    expect(result).not.toBeNull();
    expect(result?.answers.choiceQ?.type).toBe('choice');
    if (result?.answers.choiceQ?.type === 'choice') {
      expect(result.answers.choiceQ.choice).toBe('src/auth.ts');
      expect(result.answers.choiceQ.confidence).toBe(0.92);
    }
  });

  it('handles network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network drop')) as unknown as typeof fetch;

    const result = await typesafeSystemOne('key', undefined, {
      state: {},
      questions: {}
    });
    expect(result).toBeNull();
  });
});

describe('Jev semantic triage and excerpt slicing', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const fakeEnv = {
    TYPESAFE_API_KEY: 'test-jev-key'
  } as unknown as Env;

  it('ranks paths semantically based on Jev probability distribution', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          bestMatch: {
            type: 'choice',
            choice: 'src/tokens.ts',
            confidence: 0.9,
            distribution: {
              'src/tokens.ts': 0.72,
              'src/auth.ts': 0.2,
              'src/ui.tsx': 0.01,
              'README.md': 0.07
            }
          }
        }
      })
    }) as unknown as typeof fetch;

    const paths = ['README.md', 'src/ui.tsx', 'src/auth.ts', 'src/tokens.ts'];
    const ranked = await semanticPathTriage(fakeEnv, paths, 'refresh token rotation');

    expect(ranked).not.toBeNull();
    // Sorted by descending probability > 0.03
    expect(ranked).toEqual(['src/tokens.ts', 'src/auth.ts', 'README.md']);
  });

  it('extracts focused line windows from large files using Jev', async () => {
    const codeLines = Array.from({ length: 120 }, (_, i) => {
      if (i === 45) return 'export function rotateRefreshToken() { return "rotated"; }';
      return `const val_${i} = ${i};`;
    }).join('\n');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          targetSection: {
            type: 'choice',
            choice: 'L31-L70',
            confidence: 0.88,
            distribution: { 'L31-L70': 0.88 }
          },
          isRelevant: {
            type: 'noul',
            noul: 0.95
          }
        }
      })
    }) as unknown as typeof fetch;

    const excerpt = await semanticFileExcerpt(fakeEnv, 'src/auth.ts', codeLines, 'rotate refresh token');

    expect(excerpt).not.toBeNull();
    expect(excerpt?.startLine).toBe(31);
    expect(excerpt?.endLine).toBe(70);
    expect(excerpt?.content).toContain('export function rotateRefreshToken');
  });
});
