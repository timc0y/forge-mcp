import { describe, expect, it, vi } from 'vitest';
import { CHANGE_BRANCH, changeName, ensureDraftPullRequest, openChanges } from '../src/change';
import { assertNotNearExisting } from '../src/repo';
import { compare, listRepos, readFiles, readTree } from '../src/read';
import { commitFiles } from '../src/write';
import { isForgeError } from '../src/errors';
import type { GitHubRequest } from '../src/contracts';
import type { Env } from '../src/env';
import { authorizationServerMetadata } from '../src/oauth';
import { issueRefreshToken, rotateRefreshToken } from '../src/identity';
import { exactOccurrenceContexts, extractDeclaredQualityScripts, historyScope, isChurnQuery, isCodeownersPath, isDependencyManifestPath, isLanguagesQuery, isMigrationQuery, isQualityQuery, isReviewQuery, lintCommittedFiles, migrationHistoryEvidence, patchIdentifierCandidates, qualityCandidatePaths, representativePatchHunks, repositoryStats, splitPatchHunks } from '../src/repository-intelligence';

/**
 * These are the rules that, if they break, break the product rather than a
 * feature. Each one names the failure it prevents.
 */

/** A GitHubRequest built from a fixed routing table — the contract's one seam. */
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

describe('Forge has one change branch', () => {
  it('uses one fixed Git ref', () => {
    expect(CHANGE_BRANCH).toBe('forge');
    expect(changeName(CHANGE_BRANCH)).toBe('forge');
  });
});

describe('creating a repository by writing to it', () => {
  const existing = ['forge-mcp', 'headteacher-app', 'notes'];

  it('allows a clearly new name', () => {
    expect(() => assertNotNearExisting('weather-thing', existing)).not.toThrow();
  });

  it('refuses a typo of an existing repo and names the candidate', () => {
    // Without this, one dropped character silently creates an orphan repo and
    // the work lands somewhere nobody looks.
    try {
      assertNotNearExisting('forge-mcpp', existing);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isForgeError(error)).toBe(true);
      if (isForgeError(error)) {
        expect(error.code).toBe('FORGE_AMBIGUOUS');
        expect(error.message).toContain('forge-mcp');
      }
    }
  });

  it('treats an exact name as the same repository, not a new one', () => {
    expect(() => assertNotNearExisting('notes', existing)).toThrow();
  });
});

describe('GitHub navigation payload integrity', () => {
  it('refuses an unreadable repository-list payload instead of reporting zero repositories', async () => {
    const request: GitHubRequest = async () => ({
      status: 200,
      json: { repositories: 'not-an-array' },
      text: '',
      headers: new Headers()
    });
    await expect(listRepos(request)).rejects.toMatchObject({ code: 'FORGE_UPSTREAM_UNAVAILABLE' });
  });

  it('refuses an unreadable tree payload instead of reporting an empty repository', async () => {
    const request: GitHubRequest = async () => ({
      status: 200,
      json: { tree: 'not-an-array', truncated: false },
      text: '',
      headers: new Headers()
    });
    await expect(readTree(request, { owner: 'o', name: 'r' }, 'main')).rejects.toMatchObject({
      code: 'FORGE_UPSTREAM_UNAVAILABLE'
    });
  });

  it('refuses unreadable compare evidence instead of inventing a harmless diff', async () => {
    const request: GitHubRequest = async () => ({
      status: 200,
      json: { status: 'mystery', ahead_by: 0, behind_by: 0 },
      text: '',
      headers: new Headers()
    });
    await expect(compare(request, { owner: 'o', name: 'r' }, 'main', 'forge')).rejects.toMatchObject({
      code: 'FORGE_UPSTREAM_UNAVAILABLE'
    });
  });

  it('refuses malformed pull-request data instead of reporting no open changes', async () => {
    const request: GitHubRequest = async () => ({
      status: 200,
      json: [{ number: 1, head: null }],
      text: '',
      headers: new Headers()
    });
    await expect(openChanges(request, { owner: 'o', name: 'r' })).rejects.toMatchObject({
      code: 'FORGE_UPSTREAM_UNAVAILABLE'
    });
  });
});

describe('pull-request lookup integrity', () => {
  it('does not attempt PR creation when the existing-PR lookup is unavailable', async () => {
    const calls: string[] = [];
    const request: GitHubRequest = async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path.split('?')[0]}`);
      return { status: 500, json: null, text: '', headers: new Headers() };
    };

    await expect(
      ensureDraftPullRequest(request, { owner: 'o', name: 'r' }, 'forge', 'review me', 'main')
    ).rejects.toMatchObject({ code: 'FORGE_UPSTREAM_UNAVAILABLE' });
    expect(calls.some((call) => call.startsWith('POST '))).toBe(false);
  });
});

describe('reading files', () => {
  const contents = (path: string, body: string) => ({
    [`GET /repos/o/r/contents/${path}`]: {
      status: 200,
      json: { type: 'file', encoding: 'base64', content: btoa(body), size: body.length }
    }
  });

  it('returns the files that exist even when one path is wrong', async () => {
    // The client cannot loop. Losing four good files to one renamed path costs
    // a whole turn to discover something the result could have just said.
    const request = fakeGitHub({
      ...contents('a.ts', 'export const a = 1;'),
      ...contents('b.ts', 'export const b = 2;')
    });

    const result = await readFiles(request, { owner: 'o', name: 'r' }, 'main', ['a.ts', 'gone.ts', 'b.ts'], 100_000);

    expect(result.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.path).toBe('gone.ts');
  });

  it('raises when every path is missing, because then the ref is wrong', async () => {
    const request = fakeGitHub({});
    await expect(
      readFiles(request, { owner: 'o', name: 'r' }, 'no-such-branch', ['a.ts', 'b.ts'], 100_000)
    ).rejects.toMatchObject({ code: 'FORGE_NOT_FOUND' });
  });
});

describe('writing is bounded before it reaches GitHub', () => {
  const repo = { owner: 'o', name: 'r' };
  const never = fakeGitHub({});

  it('refuses more files than a chat should send in one act', async () => {
    const files = Array.from({ length: 11 }, (_unused, index) => ({
      path: `file-${index}.ts`,
      content: 'x'
    }));
    await expect(commitFiles(never, repo, 'forge/x', 'main', 'msg', files)).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED'
    });
  });

  it('refuses a payload over the size bound instead of truncating it', async () => {
    const files = [{ path: 'big.ts', content: 'x'.repeat(200 * 1024 + 1) }];
    await expect(commitFiles(never, repo, 'forge/x', 'main', 'msg', files)).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED'
    });
  });

  it('refuses the same path twice in one commit', async () => {
    const files = [
      { path: 'a.ts', content: 'one' },
      { path: 'a.ts', content: 'two' }
    ];
    await expect(commitFiles(never, repo, 'forge/x', 'main', 'msg', files)).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED'
    });
  });

  it('runs the safety gate on resolved fragment content before creating blobs', async () => {
    const calls: string[] = [];
    const request: GitHubRequest = async (path, init) => {
      const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`;
      calls.push(key);
      if (key === 'GET /repos/o/r/git/ref/heads/main') {
        return { status: 200, json: { object: { sha: 'head-1' } }, text: '', headers: new Headers() };
      }
      if (key === 'GET /repos/o/r/contents/config.ts') {
        const body = 'export const token = "SAFE";';
        return {
          status: 200,
          json: { type: 'file', encoding: 'base64', content: btoa(body), size: body.length },
          text: '',
          headers: new Headers()
        };
      }
      return { status: 404, json: null, text: '', headers: new Headers() };
    };
    const secret = `ghp_${'a'.repeat(36)}`;

    await expect(
      commitFiles(request, repo, 'main', 'main', 'replace token', [
        { path: 'config.ts', replace: [{ old: 'SAFE', new: secret }] }
      ])
    ).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });

    expect(calls.some((call) => call.includes('/git/blobs'))).toBe(false);
  });
});

describe('guidance integrity', () => {
  // Forge 1 shipped a lint for this because strings naming removed tools
  // regressed four separate times while its catalog shrank, each one found by
  // hand. A fresh codebase inherits the risk, not the immunity.
  const TOOLS = new Set(['forge_read', 'forge_edit', 'forge_merge', 'forge_discard', 'forge_see']);
  // Log event names, never shown to a model or a human.
  const LOG_EVENTS = new Set([
    'forge_tool_failed',
    'forge_capture_unmetered',
    'forge_capture_quota_release_failed'
  ]);

  it('never names a tool that does not exist', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const offenders: string[] = [];

    for (const file of readdirSync('src').filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(`src/${file}`, 'utf8');
      source.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/forge_[a-z_]+/g)) {
          const name = match[0];
          if (!TOOLS.has(name) && !LOG_EVENTS.has(name)) {
            offenders.push(`src/${file}:${index + 1} names ${name}`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

describe('repository intelligence query parsing', () => {
  it('parses bounded history scopes and language queries', () => {
    expect(historyScope('history')).toBeNull();
    expect(historyScope('history worker/src/write.ts')).toBe('worker/src/write.ts');
    expect(historyScope('authentication')).toBeUndefined();
    expect(isLanguagesQuery('languages')).toBe(true);
    expect(isChurnQuery('hot files')).toBe(true);
    expect(isReviewQuery('review packet')).toBe(true);
    expect(isMigrationQuery('migration safety')).toBe(true);
  });

  it('reports duplicate and missing numbered SQL migration prefixes without calling them deployment failures', () => {
    const evidence = migrationHistoryEvidence([
      { path: 'apps/site/migrations/0001_init.sql', type: 'file', size: 1 },
      { path: 'apps/site/migrations/0002_users.sql', type: 'file', size: 1 },
      { path: 'apps/site/migrations/0002_legacy.sql', type: 'file', size: 1 },
      { path: 'apps/site/migrations/0004_orders.sql', type: 'file', size: 1 },
      { path: 'scripts/verification/verify-d1-migration-history.mjs', type: 'file', size: 1 }
    ]);
    expect(evidence.files).toBe(4);
    expect(evidence.issues).toBe(2);
    expect(evidence.lines).toContain(
      'DUPLICATE? apps/site/migrations/ · prefix 0002 · apps/site/migrations/0002_legacy.sql, apps/site/migrations/0002_users.sql'
    );
    expect(evidence.lines).toContain('MISSING? apps/site/migrations/ · 0003');
    expect(evidence.lines).toContain('CHECKER scripts/verification/verify-d1-migration-history.mjs');
  });

  it('finds likely committed quality configuration and exact package scripts', () => {
    const candidates = qualityCandidatePaths([
      { path: '.github/workflows/ci.yml', type: 'file', size: 100 },
      { path: 'package.json', type: 'file', size: 100 },
      { path: 'src/index.ts', type: 'file', size: 100 }
    ]);
    expect(candidates).toEqual(['.github/workflows/ci.yml', 'package.json']);
    expect(isQualityQuery('quality gates')).toBe(true);
    expect(extractDeclaredQualityScripts([
      { path: 'package.json', content: JSON.stringify({ scripts: { check: 'tsc --noEmit && vitest run', start: 'node app.js' } }) }
    ])).toEqual([{ path: 'package.json', name: 'check', command: 'tsc --noEmit && vitest run' }]);
  });

  it('reports current-tree shape without assigning a quality score', () => {
    const stats = repositoryStats([
      { path: 'src', type: 'dir', size: 0 },
      { path: 'src/deep', type: 'dir', size: 0 },
      { path: 'src/deep/file.ts', type: 'file', size: 100 },
      { path: 'README.md', type: 'file', size: 50 }
    ]);
    expect(stats.lines.some((line) => line.startsWith('SHAPE max depth'))).toBe(true);
    expect(stats.lines.some((line) => line.startsWith('SHAPE widest'))).toBe(true);
  });
});

describe('patch hunk extraction', () => {
  it('splits multi-hunk patches and samples across oversized hunk sets', () => {
    const hunks = splitPatchHunks([
      {
        path: 'src/a.ts', status: 'modified', additions: 2, deletions: 2,
        patch: '@@ -1 +1 @@\n-oldAuth()\n+newAuth()\n@@ -100 +100 @@\n-oldUi()\n+newUi()'
      }
    ]);
    expect(hunks).toHaveLength(2);
    expect(hunks[1]?.header).toContain('@@ -100');
    expect(representativePatchHunks(hunks, 'auth', 1)[0]?.text).toContain('Auth');
  });
});

describe('patch impact candidate extraction', () => {
  it('extracts removed identifier candidates while ignoring language noise', () => {
    const candidates = patchIdentifierCandidates([
      {
        path: 'src/api.ts', status: 'modified', additions: 1, deletions: 1,
        patch: '@@ -1 +1 @@\n-export function legacyEndpoint() { return oldToken; }\n+export function newEndpoint() { return newToken; }'
      }
    ]);
    expect(candidates.map((candidate) => candidate.identifier)).toContain('legacyEndpoint');
    expect(candidates.map((candidate) => candidate.identifier)).toContain('oldToken');
    expect(candidates.map((candidate) => candidate.identifier)).not.toContain('function');
  });
});

describe('exact occurrence context extraction', () => {
  it('returns bounded line-local contexts without pretending they are symbols', () => {
    const result = exactOccurrenceContexts(
      [{ path: 'src/a.ts', content: 'const token = 1;\nuse(token);\n// token docs' }],
      'token',
      2
    );
    expect(result.contexts.map((context) => context.line)).toEqual([1, 2]);
    expect(result.truncated).toBe(true);
  });
});

describe('special committed-file detection', () => {
  it('recognizes GitHub CODEOWNERS locations', () => {
    expect(isCodeownersPath('CODEOWNERS')).toBe(true);
    expect(isCodeownersPath('.github/CODEOWNERS')).toBe(true);
    expect(isCodeownersPath('docs/CODEOWNERS')).toBe(true);
    expect(isCodeownersPath('src/CODEOWNERS')).toBe(false);
  });
});

describe('dependency manifest detection', () => {
  it('recognizes common dependency manifests without treating ordinary source as one', () => {
    expect(isDependencyManifestPath('package.json')).toBe(true);
    expect(isDependencyManifestPath('apps/web/pnpm-lock.yaml')).toBe(true);
    expect(isDependencyManifestPath('backend/requirements-prod.txt')).toBe(true);
    expect(isDependencyManifestPath('src/package.ts')).toBe(false);
  });
});

describe('post-commit advisory lint', () => {
  it('spots a missing relative import from committed content and tree state', async () => {
    const warnings = await lintCommittedFiles(
      [{ path: 'src/index.ts', content: "import { x } from './missing';\nexport const y = x;" }],
      ['src/index.ts', 'src/existing.ts']
    );

    expect(warnings).toEqual([
      'Post-commit notice: src/index.ts imports "./missing", but no matching committed file was found.'
    ]);
  });

  it('accepts extensionless imports when the committed target exists', async () => {
    const warnings = await lintCommittedFiles(
      [{ path: 'src/index.ts', content: "import { x } from './existing';\nexport const y = x;" }],
      ['src/index.ts', 'src/existing.ts']
    );

    expect(warnings).toEqual([]);
  });

  it('spots committed merge-conflict markers in source files', async () => {
    const warnings = await lintCommittedFiles(
      [{ path: 'src/index.ts', content: '<<<<<<< ours\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> theirs' }],
      ['src/index.ts']
    );

    expect(warnings).toContain('Post-commit notice: src/index.ts contains merge-conflict markers.');
  });

  it('spots invalid committed JSON', async () => {
    const warnings = await lintCommittedFiles([{ path: 'package.json', content: '{"name":}' }], ['package.json']);

    expect(warnings).toContain('Post-commit notice: package.json is not valid JSON.');
  });

  it('checks CommonJS relative requires against committed paths', async () => {
    const warnings = await lintCommittedFiles(
      [{ path: 'src/index.cjs', content: "const helper = require('./missing-helper');" }],
      ['src/index.cjs']
    );

    expect(warnings[0]).toContain('imports "./missing-helper"');
  });

  it('does not treat import examples inside strings as real module dependencies', async () => {
    const warnings = await lintCommittedFiles(
      [{
        path: 'src/search.test.ts',
        content: `const fixture = "import { Context } from './context';";\nexport const result = fixture;`
      }],
      ['src/search.test.ts']
    );

    expect(warnings).toEqual([]);
  });
});

describe('server instructions', () => {
  it('keeps the user OAuth credential out of installed-repository work', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/tools.ts', 'utf8');
    expect(source).not.toContain('ghForRepo');
    expect(source.match(/ctx\.ghUser/g)?.length ?? 0).toBe(3);
    expect(source).toContain('searchGitHubRepos(ctx.ghUser');
    expect(source).toContain('searchGitHubCode(ctx.ghUser');
    expect(source).toContain('createRepo(ctx.ghUser');
  });

  it('keeps deployment smoke aligned with the MCP release version and retired routes removed', async () => {
    const { readFileSync } = await import('node:fs');
    const { SERVER_VERSION } = await import('../src/mcp');
    const smoke = readFileSync('scripts/smoke.sh', 'utf8');
    expect(smoke).toContain(`"version":"${SERVER_VERSION}"`);
    expect(smoke).not.toContain('/see/');
  });

  it('keeps every load-bearing fact inside the 512-character window', async () => {
    // OpenAI weights the first 512 characters of server instructions most
    // heavily. A fact past the cut is a fact the model may never weigh, so the
    // budget is a test rather than a comment someone edits past.
    const { LEAD } = await import('../src/instructions');
    expect(LEAD.length).toBeLessThanOrEqual(512);
  });
});

describe('OAuth remains connected in ChatGPT', () => {
  type RefreshRow = {
    tokenHash: string;
    familyId: string;
    userId: string;
    clientId: string;
    keyTag: string;
    expiresAt: string;
    usedAt: string | null;
    revokedAt: string | null;
  };

  function memoryRefreshEnv() {
    const rows = new Map<string, RefreshRow>();
    const users = new Set(['user-1']);
    const metadata = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (sql.includes('INSERT INTO oauth_refresh_tokens')) {
                  const [tokenHash, familyId, userId, clientId, keyTag, expiresAt] = args as [
                    string,
                    string,
                    string,
                    string,
                    string,
                    string
                  ];
                  rows.set(tokenHash, {
                    tokenHash,
                    familyId,
                    userId,
                    clientId,
                    keyTag,
                    expiresAt,
                    usedAt: null,
                    revokedAt: null
                  });
                  return { meta: { changes: 1 } };
                }

                if (sql.includes('SET used_at')) {
                  const [usedAt, tokenHash] = args as [string, string];
                  const row = rows.get(tokenHash);
                  if (!row || row.usedAt || row.revokedAt) return { meta: { changes: 0 } };
                  row.usedAt = usedAt;
                  return { meta: { changes: 1 } };
                }

                if (sql.includes('SET revoked_at')) {
                  const [revokedAt, familyId] = args as [string, string];
                  let changes = 0;
                  for (const row of rows.values()) {
                    if (row.familyId === familyId && !row.revokedAt) {
                      row.revokedAt = revokedAt;
                      changes += 1;
                    }
                  }
                  return { meta: { changes } };
                }

                throw new Error(`Unhandled SQL in refresh-token test: ${sql}`);
              },
              async first<T>() {
                if (sql.includes('SELECT r.family_id')) {
                  const [tokenHash] = args as [string];
                  const row = rows.get(tokenHash);
                  if (!row || !users.has(row.userId)) return null as T | null;
                  return {
                    family_id: row.familyId,
                    user_id: row.userId,
                    client_id: row.clientId,
                    key_tag: row.keyTag,
                    expires_at: row.expiresAt,
                    used_at: row.usedAt,
                    revoked_at: row.revokedAt
                  } as T;
                }
                throw new Error(`Unhandled SELECT in refresh-token test: ${sql}`);
              }
            };
          }
        };
      }
    };

    return {
      env: {
        FORGE_SIGNING_KEY: 'test-signing-key-with-at-least-32-bytes',
        METADATA: metadata
      } as unknown as Env,
      rows
    };
  }

  it('advertises offline access and the refresh-token grant', async () => {
    const response = authorizationServerMetadata({
      FORGE_SIGNING_KEY: 'test-signing-key-with-at-least-32-bytes',
      FORGE_PUBLIC_ORIGIN: 'https://example.com/forge'
    } as unknown as Env);
    const metadata = await response.json() as {
      scopes_supported?: string[];
      grant_types_supported?: string[];
    };

    expect(metadata.scopes_supported).toContain('offline_access');
    expect(metadata.grant_types_supported).toContain('refresh_token');
  });

  it('binds a refresh token to the client that received it', async () => {
    const { env } = memoryRefreshEnv();
    const refresh = await issueRefreshToken(env, 'user-1', 'client-1');

    await expect(rotateRefreshToken(env, refresh, 'client-2')).resolves.toBeNull();
    await expect(rotateRefreshToken(env, refresh, 'client-1')).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('rotates refresh tokens and revokes a family on replay', async () => {
    const { env } = memoryRefreshEnv();
    const refresh = await issueRefreshToken(env, 'user-1', 'client-1');

    const result = await rotateRefreshToken(env, refresh, 'client-1');
    expect(result?.userId).toBe('user-1');
    expect(result?.refreshToken).toMatch(/^fr_/);
    expect(result?.refreshToken).not.toBe(refresh);

    await expect(rotateRefreshToken(env, refresh, 'client-1')).resolves.toBeNull();
    await expect(rotateRefreshToken(env, result!.refreshToken, 'client-1')).resolves.toBeNull();
  });

  it('expires refresh tokens after 30 days of inactivity', async () => {
    const { env } = memoryRefreshEnv();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
      const refresh = await issueRefreshToken(env, 'user-1', 'client-1');
      vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));

      await expect(rotateRefreshToken(env, refresh, 'client-1')).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates tokens issued under a rotated signing key', async () => {
    const { env } = memoryRefreshEnv();
    const refresh = await issueRefreshToken(env, 'user-1', 'client-1');
    env.FORGE_SIGNING_KEY = 'a-different-signing-key-with-at-least-32-bytes';

    await expect(rotateRefreshToken(env, refresh, 'client-1')).resolves.toBeNull();
  });
});
