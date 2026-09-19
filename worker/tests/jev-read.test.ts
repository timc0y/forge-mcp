import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { parsePathRange, readFiles } from '../src/read';
import { semanticFileExcerpt, semanticPathTriageDetailed, typesafeSystemOne, type JevChoiceAnswer } from '../src/jev';
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

    const posted = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
    expect(posted.model).toBe('jev-latest');
    expect(posted.questions.choiceQ.criteria).toEqual({
      'src/auth.ts': 'src/auth.ts',
      'src/index.ts': 'src/index.ts'
    });

    expect(result).not.toBeNull();
    expect(result?.answers.choiceQ?.type).toBe('choice');
    if (result?.answers.choiceQ?.type === 'choice') {
      expect(result.answers.choiceQ.choice).toBe('src/auth.ts');
      expect(result.answers.choiceQ.confidence).toBe(0.92);
    }
  });

  it('parses score answers as scores rather than noul probabilities', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          relevance: { type: 'score', score: 7.5, confidence: 0.91 }
        }
      })
    }) as unknown as typeof fetch;

    const result = await typesafeSystemOne('jev_test_key', undefined, {
      state: { query: 'repository relevance' },
      questions: {
        relevance: {
          type: 'score',
          instructions: 'Score relevance',
          criteria: [0, 10]
        }
      }
    });

    expect(result?.answers.relevance).toEqual({ type: 'score', score: 7.5, confidence: 0.91 });
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

  it('globally reranks winners from multiple semantic path batches', async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, json: async () => ({ answers: { bestMatch: { type: 'choice', choice: 'src/a.ts', distribution: { 'src/a.ts': 0.8 } }, exists: { type: 'noul', noul: 0.9 } } }) };
      }
      if (call === 2) {
        return { ok: true, json: async () => ({ answers: { bestMatch: { type: 'choice', choice: 'src/z.ts', distribution: { 'src/z.ts': 0.95 } }, exists: { type: 'noul', noul: 0.95 } } }) };
      }
      return { ok: true, json: async () => ({ answers: { bestMatch: { type: 'choice', choice: 'src/z.ts', distribution: { 'src/z.ts': 0.9, 'src/a.ts': 0.1 } }, exists: { type: 'noul', noul: 0.95 } } }) };
    }) as unknown as typeof fetch;

    const paths = Array.from({ length: 201 }, (_, index) => index === 0 ? 'src/a.ts' : index === 200 ? 'src/z.ts' : `src/file-${index}.ts`);
    const result = await semanticPathTriageDetailed(fakeEnv, paths, 'token rotation');

    expect(result?.paths[0]).toBe('src/z.ts');
    expect(call).toBe(3);
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

  it('can select a relevant section near the end of a file longer than the old 1,200-line window', async () => {
    const codeLines = Array.from({ length: 1800 }, (_, index) =>
      index === 1700 ? 'export function finalCredentialRotation() { return true; }' : `const line_${index} = ${index};`
    ).join('\n');

    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const sections = body.state?.sections ?? body.input?.state?.sections ?? [];
      const target = sections.find((section: { preview?: string }) => section.preview?.includes('finalCredentialRotation'))?.range ?? sections.at(-1)?.range;
      return {
        ok: true,
        json: async () => ({ answers: { targetSection: { type: 'choice', choice: target }, isRelevant: { type: 'noul', noul: 0.98 } } })
      };
    }) as unknown as typeof fetch;

    const excerpt = await semanticFileExcerpt(fakeEnv, 'src/huge.ts', codeLines, 'final credential rotation');
    expect(excerpt?.content).toContain('finalCredentialRotation');
    expect((excerpt?.startLine ?? 0)).toBeGreaterThan(1600);
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

import { judgeSeePacket, lineFromChoice, rankChangeFilesWithJev } from "../src/jev";
import { lintCommittedFiles } from "../src/repository-intelligence";

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

describe("judgeSeePacket", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("points at an outline line and asks the agent to read", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          isError: { type: "noul", noul: 0.04 },
          exists: { type: "noul", noul: 0.92 },
          suspect: { type: "choice", choice: "L4" }
        }
      })
    }) as unknown as typeof fetch;

    const outline = [
      "banner",
      "navigation",
      "heading: Supercharge your workflow",
      "button: Menu"
    ];
    const pointer = await judgeSeePacket(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "https://example.com",
      "Example App",
      outline
    );

    expect(pointer).toEqual({
      isErrorPage: false,
      suspect: "button: Menu",
      exists: 0.92,
      next: "read"
    });
  });

  it("abstains when the outline has no usable landmark", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          isError: { type: "noul", noul: 0.1 },
          exists: { type: "noul", noul: 0.08 },
          suspect: { type: "choice", choice: "L1" }
        }
      })
    }) as unknown as typeof fetch;

    const pointer = await judgeSeePacket(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "https://example.com",
      "Empty",
      ["text: loading"]
    );

    expect(pointer?.suspect).toBeNull();
    expect(pointer?.next).toBe("stop");
  });

  it("stops on error pages", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          isError: { type: "noul", noul: 0.95 },
          exists: { type: "noul", noul: 0.2 },
          suspect: { type: "choice", choice: "L1" }
        }
      })
    }) as unknown as typeof fetch;

    const pointer = await judgeSeePacket(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "https://example.com/broken",
      "404 Not Found",
      ["heading: 404 Not Found"]
    );

    expect(pointer?.isErrorPage).toBe(true);
    expect(pointer?.next).toBe("stop");
    expect(pointer?.suspect).toBe("heading: 404 Not Found");
  });
});

describe("lineFromChoice", () => {
  const ids = ["L1", "L2"];
  const lines = ["banner", "button: Menu"];

  it("resolves L-ids, case, and line text", () => {
    expect(lineFromChoice("L2", ids, lines)).toBe("button: Menu");
    expect(lineFromChoice("l1", ids, lines)).toBe("banner");
    expect(lineFromChoice("button: Menu", ids, lines)).toBe("button: Menu");
    expect(lineFromChoice("nope", ids, lines)).toBeNull();
  });
});

describe("typesafeSystemOne noul field names", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads TypeSafe probability as noul", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          isError: { type: "noul", probability: 0.02 },
          exists: { type: "noul", probability: 0.91 },
          suspect: { type: "choice", choice: "button: Menu" }
        }
      })
    }) as unknown as typeof fetch;

    const pointer = await judgeSeePacket(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "https://example.com",
      "App",
      ["banner", "button: Menu"]
    );
    expect(pointer?.exists).toBe(0.91);
    expect(pointer?.suspect).toBe("button: Menu");
    expect(pointer?.next).toBe("read");
  });
});

import { assessChangeWithJev, changeAssessmentNotices, classifyExactMatchContextsWithJev, classifyQualityGatesWithJev, rankImpactIdentifiersWithJev, rankPatchHunksWithJev, summarizeChangeImpactWithJev } from "../src/jev";

describe("rankPatchHunksWithJev", () => {
  it("selects the relevant hunk within a changed file", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          relevantHunk: {
            type: 'choice', choice: 'H2', confidence: 0.93,
            distribution: { H2: 0.9, H1: 0.1 }
          },
          hasRelevantHunk: { type: 'noul', noul: 0.96 }
        }
      })
    }) as unknown as typeof fetch;

    const ranked = await rankPatchHunksWithJev(
      { TYPESAFE_API_KEY: 'key' } as unknown as Env,
      [
        { id: 'H1', path: 'src/a.ts', header: '@@ -1 +1 @@', text: '-oldUi\n+newUi' },
        { id: 'H2', path: 'src/a.ts', header: '@@ -50 +50 @@', text: '-oldAuth\n+newAuth' }
      ],
      'authentication changes'
    );
    expect(ranked[0]).toMatchObject({ id: 'H2', path: 'src/a.ts' });
  });
});

describe("rankImpactIdentifiersWithJev", () => {
  it("ranks externally meaningful removed identifiers above local noise", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          mostImpactful: {
            type: 'choice', choice: 'legacyEndpoint', confidence: 0.9,
            distribution: { legacyEndpoint: 0.82, localHelper: 0.12 }
          },
          hasMeaningfulCandidate: { type: 'noul', noul: 0.95 }
        }
      })
    }) as unknown as typeof fetch;

    const ranked = await rankImpactIdentifiersWithJev(
      { TYPESAFE_API_KEY: 'key' } as unknown as Env,
      'replace legacy API',
      [
        { identifier: 'localHelper', occurrences: 3, paths: ['src/a.ts'] },
        { identifier: 'legacyEndpoint', occurrences: 1, paths: ['src/api.ts'] }
      ]
    );
    expect(ranked[0]).toBe('legacyEndpoint');
  });
});

describe("classifyExactMatchContextsWithJev", () => {
  it("separates declaration, reference and prose occurrences in one Jev fan-out", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          match_M1: { type: 'choice', choice: 'declaration/definition', confidence: 0.96 },
          match_M2: { type: 'choice', choice: 'code reference/call', confidence: 0.9 },
          match_M3: { type: 'choice', choice: 'documentation/prose', confidence: 0.93 }
        }
      })
    }) as unknown as typeof fetch;

    const result = await classifyExactMatchContextsWithJev(
      { TYPESAFE_API_KEY: 'key' } as unknown as Env,
      'token',
      [
        { id: 'M1', path: 'src/a.ts', line: 1, snippet: 'L1: export const token = 1;' },
        { id: 'M2', path: 'src/b.ts', line: 4, snippet: 'L4: rotate(token);' },
        { id: 'M3', path: 'README.md', line: 8, snippet: 'L8: The token is rotated.' }
      ]
    );

    expect(result.map((match) => match.kind)).toEqual([
      'declaration/definition',
      'code reference/call',
      'documentation/prose'
    ]);
  });
});

describe("classifyQualityGatesWithJev", () => {
  it("maps oddly named committed configuration to gate categories without claiming execution", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          gate_tests: { type: 'choice', choice: '.github/workflows/guard.yml', confidence: 0.92 },
          gate_types: { type: 'choice', choice: 'package.json', confidence: 0.88 },
          gate_lint_format: { type: 'choice', choice: 'none', confidence: 0.8 },
          gate_security: { type: 'choice', choice: 'none', confidence: 0.8 },
          gate_build: { type: 'choice', choice: 'none', confidence: 0.8 },
          gate_deploy: { type: 'choice', choice: 'none', confidence: 0.8 },
          gate_dependencies: { type: 'choice', choice: 'none', confidence: 0.8 }
        }
      })
    }) as unknown as typeof fetch;

    const gates = await classifyQualityGatesWithJev(
      { TYPESAFE_API_KEY: 'key' } as unknown as Env,
      [
        { path: '.github/workflows/guard.yml', content: 'jobs:\n  verify_everything:\n    steps:\n      - run: pnpm test' },
        { path: 'package.json', content: '{"scripts":{"prove":"tsc --noEmit"}}' }
      ]
    );

    expect(gates.map((gate) => [gate.kind, gate.path])).toEqual([
      ['tests', '.github/workflows/guard.yml'],
      ['types', 'package.json']
    ]);
  });
});

describe("assessChangeWithJev", () => {
  it("returns independent change signals and a scoped outlier", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          primaryArea: { type: "choice", choice: "authentication/security", confidence: 0.93 },
          matchesIntent: { type: "noul", noul: 0.94 },
          breakingChange: { type: "noul", noul: 0.1 },
          securitySensitive: { type: "noul", noul: 0.96 },
          persistentDataChange: { type: "noul", noul: 0.05 },
          userVisible: { type: "noul", noul: 0.4 },
          testsRelevant: { type: "noul", noul: 0.95 },
          docsRelevant: { type: "noul", noul: 0.2 },
          multipleConcerns: { type: "noul", noul: 0.1 },
          hasOutlier: { type: "noul", noul: 0.9 },
          outlierFile: { type: "choice", choice: "src/unrelated.ts" }
        }
      })
    }) as unknown as typeof fetch;

    const comparison = {
      status: "ahead" as const,
      aheadBy: 1,
      behindBy: 0,
      truncated: false,
      files: [
        { status: "modified" as const, path: "src/auth.ts", additions: 20, deletions: 3, patch: "+rotateCredential()" },
        { status: "modified" as const, path: "src/unrelated.ts", additions: 2, deletions: 1, patch: "+unrelated()" }
      ]
    };
    const assessment = await assessChangeWithJev(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "rotate credentials safely",
      comparison
    );

    expect(assessment?.primaryArea).toBe("authentication/security");
    expect(assessment?.outlierPath).toBe("src/unrelated.ts");
    expect(changeAssessmentNotices(assessment!, comparison)).toContain(
      "Jev notice: src/unrelated.ts looks like a scope outlier relative to the rest of this change."
    );
    expect(changeAssessmentNotices(assessment!, comparison).some((notice) => notice.includes("tests appear materially relevant"))).toBe(true);
  });
});

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
          primaryArea: { type: "choice", choice: "general code", confidence: 0.9 },
          matchesIntent: { type: "noul", noul: 0.9 },
          breakingChange: { type: "noul", noul: 0.1 },
          securitySensitive: { type: "noul", noul: 0.1 },
          persistentDataChange: { type: "noul", noul: 0.1 },
          userVisible: { type: "noul", noul: 0.1 },
          testsRelevant: { type: "noul", noul: 0.5 },
          docsRelevant: { type: "noul", noul: 0.1 },
          multipleConcerns: { type: "noul", noul: 0.1 },
          hasOutlier: { type: "noul", noul: 0.1 },
          outlierFile: { type: "choice", choice: "src/auth.ts" }
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

    expect(summary).toBe("General code: 2 files.");
  });

  it("adds cautionary warning when breaking change is detected", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          primaryArea: { type: "choice", choice: "api/integration", confidence: 0.9 },
          matchesIntent: { type: "noul", noul: 0.9 },
          breakingChange: { type: "noul", noul: 0.95 },
          securitySensitive: { type: "noul", noul: 0.1 },
          persistentDataChange: { type: "noul", noul: 0.1 },
          userVisible: { type: "noul", noul: 0.9 },
          testsRelevant: { type: "noul", noul: 0.8 },
          docsRelevant: { type: "noul", noul: 0.8 },
          multipleConcerns: { type: "noul", noul: 0.1 },
          hasOutlier: { type: "noul", noul: 0.1 }
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

    expect(summary).toContain("potentially breaking");
  });
});

describe("typesafeSystemOne Cloudflare Workers AI protocol", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("handles Cloudflare Workers AI envelope, record criteria normalization, and probabilities parsing", async () => {
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({
          result: {
            state: "Completed",
            result: {
              model: "jev-1.13.0",
              answers: {
                target: {
                  type: "choice",
                  choice: "worker/src/read.ts",
                  probabilities: {
                    "worker/src/read.ts": 0.98,
                    "worker/src/write.ts": 0.02
                  },
                  confidence: 0.98
                }
              }
            }
          },
          success: true
        })
      };
    }) as unknown as typeof fetch;

    const res = await typesafeSystemOne(
      "cfut_test_token_12345",
      "https://api.cloudflare.com/client/v4/accounts/test_account/ai/run",
      {
        state: { query: "read files" },
        questions: {
          target: {
            type: "choice",
            instructions: "Which file?",
            criteria: ["worker/src/read.ts", "worker/src/write.ts"]
          }
        }
      }
    );

    expect(capturedBody).not.toBeNull();
    expect(capturedBody.model).toBe("typesafe/jev");
    expect(capturedBody.input).toBeDefined();
    // Verify array criteria was normalized to Record for Cloudflare
    expect(capturedBody.input.questions.target.criteria).toEqual({
      "worker/src/read.ts": "worker/src/read.ts",
      "worker/src/write.ts": "worker/src/write.ts"
    });

    expect(res).not.toBeNull();
    const ans = res?.answers.target as JevChoiceAnswer;
    expect(ans.choice).toBe("worker/src/read.ts");
    // Verify probabilities was normalized into distribution
    expect(ans.distribution).toEqual({
      "worker/src/read.ts": 0.98,
      "worker/src/write.ts": 0.02
    });
  });
});

describe("judgeSeePacket extended properties", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts pageType and flags unlabeled controls", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          isError: { type: "noul", noul: 0.05 },
          exists: { type: "noul", noul: 0.95 },
          suspect: { type: "choice", choice: "L1" },
          pageType: { type: "choice", choice: "dashboard" },
          hasUnlabeledControls: { type: "noul", noul: 0.88 }
        }
      })
    }) as unknown as typeof fetch;

    const pointer = await judgeSeePacket(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "https://example.com/dash",
      "Dashboard",
      ["heading: Analytics Overview", "button: "]
    );

    expect(pointer).not.toBeNull();
    expect(pointer?.pageType).toBe("dashboard");
    expect(pointer?.hasUnlabeledControls).toBe(true);
    expect(pointer?.suspect).toBe("heading: Analytics Overview");
  });
});

describe("lintCommittedFiles", () => {
  it("detects dangling local relative imports", async () => {
    const warnings = await lintCommittedFiles(
      [{ path: "src/index.ts", content: "import { helper } from './helper';\nexport const x = 1;" }],
      ["src/index.ts", "package.json", "tsconfig.json"]
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("imports \"./helper\"");
  });

  it("does not warn when the imported file is present in the committed tree", async () => {
    const warnings = await lintCommittedFiles(
      [
        { path: "src/index.ts", content: "import { helper } from './helper';\nexport const x = 1;" },
        { path: "src/helper.ts", content: "export const helper = () => {};" }
      ],
      ["src/index.ts", "src/helper.ts"]
    );

    expect(warnings).toEqual([]);
  });
});
