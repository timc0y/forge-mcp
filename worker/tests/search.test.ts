import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildPublicSearchQuery,
  buildSearchQuery,
  rankSearchResultsWithJev,
  searchGitHubCode,
  searchGitHubRepos,
  type SearchItem
} from '../src/search';
import { registerTools, type ToolContext } from '../src/tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GitHubRequest } from '../src/contracts';
import type { Env } from '../src/env';

describe('GitHub search query shaping', () => {
  it('adds obvious language and code-noise filters', () => {
    const query = buildSearchQuery('oauth callback in typescript', 'code');
    expect(query).toContain('oauth callback in typescript');
    expect(query).toContain('language:typescript');
    expect(query).toContain('NOT path:test/');
    expect(query).toContain('NOT path:vendor/');
    expect(query).toContain('NOT path:node_modules/');
  });

  it('adds repository noise filters', () => {
    const query = buildSearchQuery('mcp server typescript', 'repos');
    expect(query).toContain('language:typescript');
    expect(query).toContain('fork:false');
    expect(query).toContain('archived:false');
  });

  it('preserves native GitHub qualifiers exactly', () => {
    const query = 'repo:cloudflare/workers-sdk path:packages/ stars:>100';
    expect(buildSearchQuery(query, 'code')).toBe(query);
  });

  it('forces explicit global search to public visibility', () => {
    expect(buildPublicSearchQuery('mcp server', 'repos')).toContain('is:public');
    const forced = buildPublicSearchQuery('oauth is:private', 'code');
    expect(forced).toContain('is:public');
    expect(forced).not.toContain('is:private');
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

  it('does not turn an unavailable repository search into zero matches', async () => {
    const fakeReq: GitHubRequest = async () => ({
      status: 403,
      headers: new Headers(),
      text: '',
      json: { message: 'rate limit' }
    });

    const res = await searchGitHubRepos(fakeReq, 'anything', 5);
    expect(res.total).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.unavailable).toContain('No absence conclusion was made');
  });

  it('does not turn an unavailable code search into zero matches', async () => {
    const fakeReq: GitHubRequest = async () => ({
      status: 429,
      headers: new Headers(),
      text: '',
      json: { message: 'rate limit' }
    });

    const res = await searchGitHubCode(fakeReq, 'anything', 5);
    expect(res.total).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.unavailable).toContain('rate limited');
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
          isUseful: {
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

describe("searchGitHubCode fragment prioritization", () => {
  it("prefers function definitions and exports over bare imports", async () => {
    const fakeRequest = async () => ({
      status: 200,
      json: {
        total_count: 1,
        items: [
          {
            name: "router.ts",
            path: "src/router.ts",
            html_url: "https://github.com/honojs/hono/blob/main/src/router.ts",
            repository: { full_name: "honojs/hono", description: "Fast router" },
            text_matches: [
              { fragment: "import { Context } from './context';" },
              { fragment: "export class Router { add(method: string, path: string) {} }" }
            ]
          }
        ]
      }
    });

    const result = await searchGitHubCode(fakeRequest as any, "Router add method");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.snippet).toContain("export class Router");
  });
});
