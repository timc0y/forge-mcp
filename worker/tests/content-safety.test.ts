import { afterEach, describe, expect, it, vi } from 'vitest';
import { author } from '../src/authoring';
import { containsHighSeveritySecret } from '../src/content-safety';
import { RequestBudget } from '../src/evidence';
import { evaluate, redactSemanticText, type Question } from '../src/semantics';
import { commitFiles } from '../src/write';
import type { GitHubRequest } from '../src/contracts';
import type { Env } from '../src/env';
import type { ToolContext } from '../src/tool-types';

// Generated, unsigned fixtures only; no credential is issued or used.
const segment = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const fixtures = [
  ...['ghp', 'gho', 'ghu', 'ghs', 'ghr'].map((family) => ({ name: family, token: family + '_' + 'aB12'.repeat(9) })),
  { name: 'fine-grained PAT', token: 'github_pat_' + 'aB'.repeat(41) },
  ...[1, 12345678].map((appId) => ({
    name: `stateless installation token for app ${appId}`,
    token: 'ghs_' + appId + '_' + segment({ alg: 'ES256' }) + '.' + segment({ synthetic: true, padding: 'x'.repeat(260) }) + '.' + '-_'.repeat(43)
  }))
];
const questions: Record<string, Question> = { relevant: { type: 'noul', instructions: 'Does this synthetic source help?' } };
const env = { TYPESAFE_API_KEY: 'synthetic', TYPESAFE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/ai/run' } as Env;

afterEach(() => vi.unstubAllGlobals());

describe('shared GitHub credential recognition', () => {
  it.each(fixtures)('refuses $name before semantic redaction, JEV, or author effects', async ({ token }) => {
    const content = `const credential = "${token}";`;
    const fetch = vi.fn(async () => { throw new Error('Unexpected provider request'); });
    vi.stubGlobal('fetch', fetch);
    const gh = vi.fn<GitHubRequest>(async () => { throw new Error('Unexpected GitHub request'); });
    const track = vi.fn();
    const ctx: ToolContext = { env, identity: { userId: 'synthetic', githubLogin: 'o' }, gh, ghUser: gh, track };

    expect(containsHighSeveritySecret(content)).toBe(true);
    expect(() => redactSemanticText(content)).toThrow(/high-severity secret/);
    await expect(evaluate(env, { source: content }, questions, 'synthetic/v1', new RequestBudget())).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
    await expect(author(ctx, { repo: 'o/r', message: 'Save synthetic file', files: [{ path: 'a.ts', content }] })).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it.each(fixtures)('refuses $name in resolved fragment content before any GitHub mutation', async ({ token }) => {
    const head = 'a'.repeat(40);
    const requests: Array<{ path: string; method: string }> = [];
    const gh: GitHubRequest = async (path, init) => {
      requests.push({ path, method: init?.method ?? 'GET' });
      const reply = (json: unknown) => ({ status: 200, json, text: '', headers: new Headers() });
      if (path === '/repos/o/r/git/ref/heads/main') return reply({ object: { sha: head } });
      if (path === `/repos/o/r/contents/a.ts?ref=${head}`) return reply({ type: 'file', size: 20, encoding: 'base64', content: btoa('const credential = "";\n') });
      throw new Error('Unexpected GitHub effect');
    };
    await expect(commitFiles(gh, { owner: 'o', name: 'r' }, 'main', 'main', 'Edit synthetic file', [{
      path: 'a.ts', edit: { expectedCommit: head, selector: 'a.ts:1-1', replacement: `const credential = "${token}";\n` }
    }])).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED', message: expect.stringContaining('secret') });
    expect(requests).toEqual([
      { path: '/repos/o/r/git/ref/heads/main', method: 'GET' },
      { path: `/repos/o/r/contents/a.ts?ref=${head}`, method: 'GET' }
    ]);
  });

  it.each([
    'GitHub token prefixes: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_.',
    'The installation token format is ghs_APPID_JWT.',
    ...['ghp', 'gho', 'ghu', 'ghs', 'ghr'].map((prefix) => prefix + '_' + 'a'.repeat(35)),
    'unrelated_' + 'a'.repeat(100),
    'const publicValue = "example";'
  ])('allows prefix documentation and unrelated source: %s', (text) => {
    expect(containsHighSeveritySecret(text)).toBe(false);
    expect(() => redactSemanticText(text)).not.toThrow();
  });
});
