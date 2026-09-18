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

import { findResilientMatch } from "../src/write";
import { checkCommitSafety, resolveRepoWithJev } from "../src/jev";

describe("findResilientMatch", () => {
  const source = `function calculateTotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}`;

  it("finds verbatim match", () => {
    const target = "  let sum = 0;\n  for (const item of items) {\n    sum += item.price;\n  }";
    const match = findResilientMatch(source, target);
    expect(match).not.toBeNull();
    expect(match?.original).toBe(target);
  });

  it("finds match across CRLF line endings", () => {
    const target = "  let sum = 0;\r\n  for (const item of items) {\r\n    sum += item.price;\r\n  }";
    const match = findResilientMatch(source, target);
    expect(match).not.toBeNull();
  });

  it("finds match when indentation drifted", () => {
    // 4 spaces indentation instead of 2 spaces
    const target = "    let sum = 0;\n    for (const item of items) {\n        sum += item.price;\n    }";
    const match = findResilientMatch(source, target);
    expect(match).not.toBeNull();
    expect(match?.original).toContain("let sum = 0;");
  });

  it("returns null when target occurs multiple times (refusing to guess)", () => {
    const repeatedSource = "const a = 1;\nconst b = 2;\nconst a = 1;";
    const target = "const a = 1;";
    const match = findResilientMatch(repeatedSource, target);
    expect(match).toBeNull();
  });
});

describe("checkCommitSafety", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("blocks commits with hardcoded private keys instantly", async () => {
    const files = [
      { path: "cert.pem", content: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA..." }
    ];
    const result = await checkCommitSafety(undefined, files);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("secret token or private key");
  });

  it("blocks commits with GitHub PAT tokens", async () => {
    const files = [
      { path: "config.json", content: "{\"token\": \"ghp_123456789012345678901234567890123456\"}" }
    ];
    const result = await checkCommitSafety(undefined, files);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("secret token or private key");
  });

  it("passes safe code commits", async () => {
    const files = [
      { path: "src/utils.ts", content: "export function add(a: number, b: number) { return a + b; }" }
    ];
    const result = await checkCommitSafety(undefined, files);
    expect(result.safe).toBe(true);
  });

  it("uses Jev to detect subtle leaks and truncations", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          hasSecretLeak: { type: "noul", noul: 0.95 },
          isAccidentalTruncation: { type: "noul", noul: 0.1 }
        }
      })
    }) as unknown as typeof fetch;

    const files = [{ path: "env.ts", content: "export const DB_SECRET = \"unredacted_prod_key\";" }];
    const result = await checkCommitSafety({ TYPESAFE_API_KEY: "key" } as unknown as Env, files);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("Jev detected likely unredacted credentials");
  });
});

describe("resolveRepoWithJev", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("disambiguates colloquial repo name to exact repo", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          matchedRepo: {
            type: "choice",
            choice: "spurwing/sitecheck-audit",
            confidence: 0.94
          },
          confidence: {
            type: "noul",
            noul: 0.94
          }
        }
      })
    }) as unknown as typeof fetch;

    const repos = [
      { repo: "timcoy/forge-mcp", description: "Minimal GitHub MCP for ChatGPT" },
      { repo: "spurwing/sitecheck-audit", description: "Headless audit worker and Playwright runner" },
      { repo: "spurwing/sitecheck-web", description: "Marketing frontend for Sitecheck" }
    ];

    const match = await resolveRepoWithJev(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "the audit worker",
      repos
    );

    expect(match).not.toBeNull();
    expect(match?.repo).toBe("spurwing/sitecheck-audit");
    expect(match?.confidence).toBe(0.94);
  });
});

import { analyzePageOutlineWithJev, rankChangeFilesWithJev } from "../src/jev";

describe("rankChangeFilesWithJev", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("ranks changed files in PR based on query", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          relevantFiles: {
            type: "choice",
            choice: "src/auth/token.ts",
            confidence: 0.9,
            distribution: {
              "src/auth/token.ts": 0.82,
              "src/user.ts": 0.12,
              "README.md": 0.02
            }
          }
        }
      })
    }) as unknown as typeof fetch;

    const files = [
      { path: "README.md", patch: "@@ -1 +1 @@\n-# Docs\n+# Documentation" },
      { path: "src/user.ts", patch: "@@ -5 +5 @@\n-const id = 1;\n+const id = 2;" },
      { path: "src/auth/token.ts", patch: "@@ -10 +10 @@\n+export function rotateToken() {}" }
    ];

    const ranked = await rankChangeFilesWithJev(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      files,
      "refresh token logic"
    );

    expect(ranked).not.toBeNull();
    expect(ranked).toEqual(["src/auth/token.ts", "src/user.ts"]);
  });
});

describe("analyzePageOutlineWithJev", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("detects error pages in forge_see", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          isError: { type: "noul", noul: 0.95 },
          pageCategory: { type: "choice", choice: "error_maintenance" }
        }
      })
    }) as unknown as typeof fetch;

    const outline = ["heading: 404 Not Found", "text: The page you requested could not be found."];
    const insight = await analyzePageOutlineWithJev(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "https://example.com/broken",
      "404 Not Found",
      outline
    );

    expect(insight).not.toBeNull();
    expect(insight?.isErrorPage).toBe(true);
    expect(insight?.summary).toContain("error or maintenance");
  });

  it("summarizes valid web pages in forge_see", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          isError: { type: "noul", noul: 0.05 },
          pageCategory: { type: "choice", choice: "marketing_landing" }
        }
      })
    }) as unknown as typeof fetch;

    const outline = ["banner", "navigation", "heading: Supercharge your workflow", "button: Get Started"];
    const insight = await analyzePageOutlineWithJev(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "https://example.com",
      "Example App",
      outline
    );

    expect(insight).not.toBeNull();
    expect(insight?.isErrorPage).toBe(false);
    expect(insight?.summary).toBe("Detected as marketing landing.");
  });
});

import { summarizeChangeImpactWithJev } from "../src/jev";

describe("summarizeChangeImpactWithJev", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("summarizes impact of change for human approval review", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          changeType: { type: "choice", choice: "feature" },
          hasBreakingChange: { type: "noul", noul: 0.1 }
        }
      })
    }) as unknown as typeof fetch;

    const comparison = {
      status: "ahead" as const,
      aheadBy: 2,
      behindBy: 0,
      truncated: false,
      files: [
        { status: "modified" as const, path: "src/auth.ts", additions: 40, deletions: 5, patch: "export function auth() {}" },
        { status: "modified" as const, path: "src/token.ts", additions: 20, deletions: 2, patch: "export function token() {}" }
      ]
    };

    const summary = await summarizeChangeImpactWithJev(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "forge",
      comparison
    );

    expect(summary).toBe("Feature: 2 files modified.");
  });

  it("adds cautionary warning when breaking change is detected", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          changeType: { type: "refactor", choice: "refactor" },
          hasBreakingChange: { type: "noul", noul: 0.95 }
        }
      })
    }) as unknown as typeof fetch;

    const comparison = {
      status: "ahead" as const,
      aheadBy: 1,
      behindBy: 0,
      truncated: false,
      files: [
        { status: "modified" as const, path: "src/api.ts", additions: 10, deletions: 50, patch: "-export function legacyEndpoint() {}" }
      ]
    };

    const summary = await summarizeChangeImpactWithJev(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "forge",
      comparison
    );

    expect(summary).toContain("Caution: potentially breaking change");
  });
});
