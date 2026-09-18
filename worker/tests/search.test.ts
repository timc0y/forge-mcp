import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  SUPPORTED_PLATFORMS,
  buildAdvancedSearchQuery,
  rankSearchResultsWithJev,
  resolveDocPlatform,
  searchGitHubCode,
  searchGitHubRepos,
  type SearchItem
} from '../src/search';
import { registerTools, type ToolContext } from '../src/tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GitHubRequest } from '../src/contracts';
import type { Env } from '../src/env';

describe('Documentation Platform Registry and Resolution', () => {
  it('contains curated platforms for major web and edge technologies', () => {
    const ids = SUPPORTED_PLATFORMS.map((p) => p.id);
    expect(ids).toContain('cloudflare');
    expect(ids).toContain('nextjs');
    expect(ids).toContain('react');
    expect(ids).toContain('tailwind');
    expect(ids).toContain('mdn');
    expect(ids).toContain('hono');
    expect(ids).toContain('mcp');
    expect(ids).toContain('bun');
    expect(ids).toContain('supabase');
    expect(ids).toContain('typescript');
    expect(ids).toContain('typesafe');
  });

  it('resolves platforms by id, name, alias, and repo name case-insensitively', () => {
    expect(resolveDocPlatform('cloudflare')?.id).toBe('cloudflare');
    expect(resolveDocPlatform('CF')?.id).toBe('cloudflare');
    expect(resolveDocPlatform('workers')?.id).toBe('cloudflare');
    expect(resolveDocPlatform('cloudflare/cloudflare-docs')?.id).toBe('cloudflare');

    expect(resolveDocPlatform('nextjs')?.id).toBe('nextjs');
    expect(resolveDocPlatform('next')?.id).toBe('nextjs');
    expect(resolveDocPlatform('vercel/next.js')?.id).toBe('nextjs');

    expect(resolveDocPlatform('react')?.id).toBe('react');
    expect(resolveDocPlatform('reactjs')?.id).toBe('react');

    expect(resolveDocPlatform('tailwind')?.id).toBe('tailwind');
    expect(resolveDocPlatform('tailwindcss')?.id).toBe('tailwind');

    expect(resolveDocPlatform('mdn')?.id).toBe('mdn');
    expect(resolveDocPlatform('mozilla')?.id).toBe('mdn');

    expect(resolveDocPlatform('hono')?.id).toBe('hono');
    expect(resolveDocPlatform('honojs')?.id).toBe('hono');

    expect(resolveDocPlatform('mcp')?.id).toBe('mcp');
    expect(resolveDocPlatform('modelcontextprotocol')?.id).toBe('mcp');

    expect(resolveDocPlatform('jev')?.id).toBe('typesafe');
    expect(resolveDocPlatform('systemone')?.id).toBe('typesafe');

    expect(resolveDocPlatform('nonexistent-platform-xyz')).toBeNull();
  });
});

describe('Advanced Search Query Synthesis', () => {
  it('detects programming languages and adds Blackbird noise suppression filters in code mode', async () => {
    const res = await buildAdvancedSearchQuery(undefined, 'oauth callback in typescript', 'code');
    expect(res.query).toContain('oauth callback in typescript');
    expect(res.query).toContain('language:typescript');
    expect(res.query).toContain('NOT path:test/');
    expect(res.query).toContain('NOT path:vendor/');
    expect(res.query).toContain('NOT path:node_modules/');
  });

  it('detects python and adds language qualifier', async () => {
    const res = await buildAdvancedSearchQuery(undefined, 'fastapi streaming response in python', 'code');
    expect(res.query).toContain('language:python');
  });

  it('constructs clean repository search queries without fork noise', async () => {
    const res = await buildAdvancedSearchQuery(undefined, 'mcp server typescript', 'repos');
    expect(res.query).toContain('mcp server typescript');
    expect(res.query).toContain('language:typescript');
    expect(res.query).toContain('fork:false');
    expect(res.query).toContain('archived:false');
  });

  it('preserves existing search qualifiers when provided directly', async () => {
    const res = await buildAdvancedSearchQuery(undefined, 'repo:cloudflare/workers-sdk path:packages/ stars:>100', 'code');
    expect(res.query).toBe('repo:cloudflare/workers-sdk path:packages/ stars:>100');
  });

  it('scopes documentation queries to the official documentation repository and path', async () => {
    const res = await buildAdvancedSearchQuery(undefined, 'cloudflare workers kv binding', 'docs');
    expect(res.detectedPlatform?.id).toBe('cloudflare');
    expect(res.query).toContain('repo:cloudflare/cloudflare-docs');
    expect(res.query).toContain('path:content/');
    expect(res.query).toContain('kv binding');
  });
});

describe('GitHub Search API calls', () => {
  it('searches repositories and formats results with stars and URLs', async () => {
    const fakeReq: GitHubRequest = async (path) => {
      expect(path).toContain('/search/repositories');
      return {
        status: 200,
        headers: new Headers(),
        text: '',
        json: {
          total_count: 1,
          items: [
            {
              full_name: 'honojs/hono',
              description: 'Fast, lightweight web framework',
              stargazers_count: 21000,
              html_url: 'https://github.com/honojs/hono'
            }
          ]
        }
      };
    };

    const res = await searchGitHubRepos(fakeReq, 'hono web framework', 5);
    expect(res.total).toBe(1);
    expect(res.items[0]?.repo).toBe('honojs/hono');
    expect(res.items[0]?.stars).toBe(21000);
    expect(res.items[0]?.snippet).toContain('Fast, lightweight');
  });

  it('searches code and extracts text_matches fragments', async () => {
    const fakeReq: GitHubRequest = async (path, init) => {
      expect(path).toContain('/search/code');
      expect(init?.accept).toBe('application/vnd.github.text-match+json');
      return {
        status: 200,
        headers: new Headers(),
        text: '',
        json: {
          total_count: 1,
          items: [
            {
              path: 'src/index.ts',
              repository: { full_name: 'example/mcp-tool' },
              html_url: 'https://github.com/example/mcp-tool/blob/main/src/index.ts',
              text_matches: [
                {
                  fragment: 'export async function runMcpTool() { return true; }'
                }
              ]
            }
          ]
        }
      };
    };

    const res = await searchGitHubCode(fakeReq, 'runMcpTool language:typescript', 5);
    expect(res.total).toBe(1);
    expect(res.items[0]?.repo).toBe('example/mcp-tool');
    expect(res.items[0]?.path).toBe('src/index.ts');
    expect(res.items[0]?.snippet).toContain('runMcpTool()');
  });
});

describe('TypeSafe Jev System One Candidate Ranking', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('ranks search candidates using System One distribution and confidence', async () => {
    const mockEnv: Partial<Env> = {
      TYPESAFE_API_KEY: 'test-jev-key',
      TYPESAFE_BASE_URL: 'https://api.typesafe.ai/v1/systemone'
    };

    const candidates: SearchItem[] = [
      { id: 'foo/boilerplate', title: 'foo/boilerplate', repo: 'foo/boilerplate', snippet: 'A toy template' },
      { id: 'cloudflare/workers-sdk', title: 'cloudflare/workers-sdk', repo: 'cloudflare/workers-sdk', snippet: 'Production Cloudflare Workers runtime and CLI' }
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          bestReference: {
            type: 'choice',
            choice: 'cloudflare/workers-sdk',
            distribution: {
              'foo/boilerplate': 0.08,
              'cloudflare/workers-sdk': 0.92
            }
          },
          isQuality: {
            type: 'noul',
            noul: 0.95
          }
        }
      })
    } as unknown as Response);

    const ranked = await rankSearchResultsWithJev(mockEnv as Env, 'cloudflare workers cli', candidates);

    expect(ranked[0]?.id).toBe('cloudflare/workers-sdk');
    expect(ranked[0]?.score).toBe(0.92);
    expect(ranked[0]?.confidence).toBe(0.95);
    expect(ranked[1]?.id).toBe('foo/boilerplate');
  });

  it('returns unranked candidates gracefully when Jev is not configured', async () => {
    const candidates: SearchItem[] = [
      { id: 'a', title: 'a', repo: 'a' },
      { id: 'b', title: 'b', repo: 'b' }
    ];
    const ranked = await rankSearchResultsWithJev(undefined, 'query', candidates);
    expect(ranked).toEqual(candidates);
  });
});

describe('End-to-End forge_read search integration', () => {
  function createTestServer(requestRoutes: Record<string, unknown>) {
    const server = new McpServer({ name: 'forge-test', version: '1.0.0' });

    const fakeGh: GitHubRequest = async (path) => {
      for (const [route, resp] of Object.entries(requestRoutes)) {
        if (path.includes(route)) {
          return {
            status: 200,
            headers: new Headers(),
            text: '',
            json: resp
          };
        }
      }
      return { status: 404, headers: new Headers(), text: '', json: null };
    };

    const ctx: ToolContext = {
      env: {} as Env,
      identity: { userId: 'u1', githubLogin: 'testuser', installationId: 'inst-1' },
      track: () => {},
      gh: fakeGh,
      ghUser: fakeGh
    };

    registerTools(server, ctx);
    return (server as any)._registeredTools['forge_read'];
  }

  it('lists supported documentation platforms when repo="docs" is requested without query', async () => {
    const readTool = createTestServer({});
    const res = await readTool.handler({ repo: 'docs' });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Forge Documentation Search supports: Cloudflare, Next.js');
    expect(res.structuredContent.platforms).toBeDefined();
    expect(res.structuredContent.platforms.length).toBeGreaterThan(5);
  });

  it('searches documentation when a platform name is specified as repo', async () => {
    const readTool = createTestServer({
      '/search/code': {
        total_count: 1,
        items: [
          {
            path: 'content/workers/runtime-apis/kv.md',
            repository: { full_name: 'cloudflare/cloudflare-docs' },
            html_url: 'https://github.com/cloudflare/cloudflare-docs/blob/production/content/workers/runtime-apis/kv.md',
            text_matches: [
              {
                fragment: 'Workers KV is a global, low-latency key-value data store.'
              }
            ]
          }
        ]
      }
    });

    const res = await readTool.handler({ repo: 'cloudflare', query: 'kv datastore' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Cloudflare documentation (cloudflare/cloudflare-docs)');
    expect(res.structuredContent.files[0].path).toContain('cloudflare/cloudflare-docs:content/workers/runtime-apis/kv.md');
    expect(res.structuredContent.files[0].text).toContain('Workers KV is a global');
  });

  it('searches public GitHub repositories when repo="global" and query mentions repos', async () => {
    const readTool = createTestServer({
      '/search/repositories': {
        total_count: 1,
        items: [
          {
            full_name: 'modelcontextprotocol/servers',
            description: 'Model Context Protocol reference servers',
            stargazers_count: 5000,
            html_url: 'https://github.com/modelcontextprotocol/servers'
          }
        ]
      }
    });

    const res = await readTool.handler({ repo: 'global', query: 'mcp reference repositories' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Found 1 public GitHub repository');
    expect(res.structuredContent.repos[0].repo).toBe('modelcontextprotocol/servers');
    expect(res.structuredContent.searchResults[0].stars).toBe(5000);
  });

  it('automatically falls back to global search when no installed repositories match the query', async () => {
    const readTool = createTestServer({
      '/installation/repositories': {
        total_count: 0,
        repositories: []
      },
      '/search/code': {
        total_count: 1,
        items: [
          {
            path: 'src/worker.ts',
            repository: { full_name: 'awesome/cloudflare-worker' },
            html_url: 'https://github.com/awesome/cloudflare-worker/blob/main/src/worker.ts',
            text_matches: [
              {
                fragment: 'export default { async fetch() { return new Response("Hello"); } }'
              }
            ]
          }
        ]
      }
    });

    const res = await readTool.handler({ query: 'cloudflare worker hello response' });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.searchResults[0].repo).toBe('awesome/cloudflare-worker');
  });
});

describe("Jev-enhanced buildAdvancedSearchQuery", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts platform, language, and core intent using Jev", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          intent: { type: "choice", choice: "docs" },
          platform: { type: "choice", choice: "cloudflare" },
          language: { type: "choice", choice: "typescript" },
          isQuestionOrHowTo: { type: "noul", noul: 0.95 }
        }
      })
    }) as unknown as typeof fetch;

    const mockEnv = {
      TYPESAFE_API_KEY: "test-key"
    } as unknown as Env;

    const res = await buildAdvancedSearchQuery(
      mockEnv,
      "how do I configure workers kv bindings in typescript?",
      "code"
    );

    expect(res.detectedPlatform?.id).toBe("cloudflare");
    expect(res.intentMode).toBe("docs");
    expect(res.query).toContain("repo:cloudflare/cloudflare-docs");
    expect(res.query).toContain("path:content/");
  });
});
