import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type ToolContext } from '../src/tool-catalog';
import type { GitHubRequest, Identity } from '../src/contracts';
import type { Env } from '../src/env';

const MAIN = 'a'.repeat(40);
const FORGE = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);

function context(routes: Record<string, { status: number; json?: unknown; text?: string }> = {}) {
  const calls: string[] = [];
  const defaults: Record<string, { status: number; json?: unknown; text?: string }> = {
    'GET /installation/repositories': {
      status: 200,
      json: { repositories: [{ name: 'test-repo', owner: { login: 'testuser' }, full_name: 'testuser/test-repo', description: 'test', default_branch: 'main', private: false, pushed_at: '2026-09-20T10:00:00Z' }] }
    },
    'GET /repos/testuser/test-repo': { status: 200, json: { default_branch: 'main', private: false } },
    'GET /repos/testuser/test-repo/commits/main': { status: 200, json: { sha: MAIN } },
    'GET /repos/testuser/test-repo/commits/forge': { status: 200, json: { sha: FORGE } },
    [`GET /repos/testuser/test-repo/git/trees/${MAIN}`]: { status: 200, json: { truncated: false, tree: [{ path: 'README.md', type: 'blob', size: 14 }, { path: 'src/index.ts', type: 'blob', size: 28 }] } },
    [`GET /repos/testuser/test-repo/git/trees/${FORGE}`]: { status: 200, json: { truncated: false, tree: [{ path: 'README.md', type: 'blob', size: 14 }, { path: 'src/index.ts', type: 'blob', size: 28 }] } },
    'GET /repos/testuser/test-repo/pulls': { status: 200, json: [{ number: 4, head: { ref: 'forge' }, base: { ref: 'main' }, title: 'Context engine', draft: true, updated_at: '2026-09-20T10:00:00Z' }] },
    'GET /repos/testuser/test-repo/contents/README.md': { status: 200, json: { type: 'file', encoding: 'base64', content: btoa('# Test Repo\n'), sha: BLOB, size: 12 } },
    [`GET /repos/testuser/test-repo/compare/${MAIN}...${FORGE}`]: { status: 200, json: { status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: 'src/index.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }] } },
    'GET /search/repositories': { status: 200, json: { total_count: 1, incomplete_results: false, items: [{ full_name: 'Aider-AI/aider', html_url: 'https://github.com/Aider-AI/aider', description: 'AI pair programming', private: false }] } },
    'GET /repos/a/b': { status: 200, json: { full_name: 'a/b', private: false, default_branch: 'main' } },
    'GET /search/code': { status: 200, json: { total_count: 1, incomplete_results: false, items: [{ path: 'src/x.ts', html_url: 'https://github.com/a/b/blob/main/src/x.ts', repository: { full_name: 'a/b', private: false }, text_matches: [{ fragment: 'needle' }] }] } }
  };
  const all = { ...defaults, ...routes };
  const gh: GitHubRequest = async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const clean = path.split('?')[0]!;
    const hit = all[`${method} ${path}`] ?? all[`${method} ${clean}`];
    return { status: hit?.status ?? 404, json: hit?.json ?? null, text: hit?.text ?? '', headers: new Headers() };
  };
  const identity: Identity = { userId: 'u', githubLogin: 'testuser', installationId: '1' };
  const env = {
    FORGE_ENVIRONMENT: 'test',
    FORGE_PUBLIC_ORIGIN: 'https://example.test/forge',
    FORGE_SIGNING_KEY: 'x'.repeat(40),
    METADATA: { prepare() { return { bind() { return { async run() { return { meta: { changes: 1 } }; }, async first() { return null; } }; } }; } }
  } as unknown as Env;
  const server = new McpServer({ name: 'Forge', version: '2.0.0' });
  const ctx: ToolContext = { env, identity, track: () => {}, gh, ghUser: gh };
  registerTools(server, ctx);
  return { server, ctx, calls };
}

describe('V2 public tool contract', () => {
  it('publishes exactly five tools with corrected risk annotations', () => {
    const { server } = context();
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools).sort()).toEqual(['forge_discard', 'forge_edit', 'forge_merge', 'forge_read', 'forge_see']);
    expect(tools.forge_read.annotations.openWorldHint).toBe(true);
    expect(tools.forge_edit.annotations.destructiveHint).toBe(true);
  });

  it('pins ordinary repository reads to an immutable commit', async () => {
    const { server, calls } = context();
    const result = await (server as any)._registeredTools.forge_read.handler({ repo: 'test-repo', paths: ['README.md'] });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.source.sha).toBe(MAIN);
    expect(result.structuredContent.files[0].text).toBe('# Test Repo\n');
    expect(calls.some((call) => call.includes(`/commits/main`))).toBe(true);
    expect(calls.some((call) => call.includes(`contents/README.md?ref=${MAIN}`))).toBe(true);
  });

  it('keeps exact source readable when the optional open-change list is unavailable', async () => {
    const { server } = context({ 'GET /repos/testuser/test-repo/pulls': { status: 403, json: { message: 'forbidden' } } });
    const result = await (server as any)._registeredTools.forge_read.handler({ repo: 'test-repo', paths: ['README.md'] });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.source.sha).toBe(MAIN);
    expect(result.structuredContent.files[0].text).toBe('# Test Repo\n');
    expect(result.structuredContent.limits.join(' ')).toContain('Open changes could not be listed');
  });

  it('keeps explicit source exact even when a question is also supplied', async () => {
    const { server } = context();
    const result = await (server as any)._registeredTools.forge_read.handler({ repo: 'test-repo', paths: ['README.md'], query: 'only the title' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.files[0].text).toBe('# Test Repo\n');
    expect(result.structuredContent.limits.join(' ')).toContain('no semantic excerpt replaced');
  });

  it('reads a proposal as a diff unless proposal source is explicitly requested', async () => {
    const { server } = context();
    const result = await (server as any)._registeredTools.forge_read.handler({ repo: 'test-repo', change: 'forge' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.diff.files[0].path).toBe('src/index.ts');
    expect(result.structuredContent.source.sha).toBe(FORGE);
  });

  it('keeps global repository discovery public and requires verified public repo scopes for code search', async () => {
    const { server, calls } = context();
    const read = (server as any)._registeredTools.forge_read;
    const repoResult = await read.handler({ repo: 'global', query: 'aider' });
    expect(repoResult.structuredContent.kind).toBe('repositories');
    expect(repoResult.structuredContent.matches[0].repo).toBe('Aider-AI/aider');

    const unscoped = await read.handler({ repo: 'global', query: 'code:needle' });
    expect(unscoped.isError).toBe(true);
    expect(calls.some((call) => call.includes('/search/code'))).toBe(false);

    const codeResult = await read.handler({ repo: 'global', query: 'code:needle repo:a/b' });
    expect(codeResult.structuredContent.kind).toBe('code');
    expect(codeResult.structuredContent.matches[0].repo).toBe('a/b');
    expect(calls.some((call) => call.includes('/repos/a/b'))).toBe(true);
    expect(calls.some((call) => call.includes('/search/code'))).toBe(true);
  });

  it('rejects retired intent and branch-like review reasons before writing', async () => {
    const { server, calls } = context();
    const edit = (server as any)._registeredTools.forge_edit;
    const retired = await edit.handler({ repo: 'test-repo', intent: 'old', message: 'x', files: [{ path: 'a.txt', content: 'x' }] });
    expect(retired.isError).toBe(true);
    for (const reason of ['forge', 'main', 'branch', 'review', 'proposal']) {
      const branch = await edit.handler({ repo: 'test-repo', change: reason, message: 'x', files: [{ path: 'a.txt', content: 'x' }] });
      expect(branch.isError, reason).toBe(true);
    }
    expect(calls.some((call) => call.startsWith('POST /repos/testuser/test-repo/git/blobs'))).toBe(false);
  });
});
