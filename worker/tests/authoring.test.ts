import { describe, expect, it } from 'vitest';
import { author } from '../src/authoring';
import type { GitHubRequest } from '../src/contracts';
import type { ToolContext } from '../src/tool-types';
import type { Env } from '../src/env';

const O = 'a'.repeat(40), C = 'c'.repeat(40), api = '/repos/alice/new-private-notes';
const reply = (json: unknown, status = 200) => ({ status, json, text: '', headers: new Headers() });
const input = { repo: 'alice/new-private-notes', private: true, message: 'Save private research', files: [{ path: 'notes.md', content: 'synthetic private research' }] };
const context = (gh: GitHubRequest): ToolContext => ({ env: {} as Env, identity: { userId: 'synthetic', githubLogin: 'alice' }, gh, ghUser: gh, track: () => {} });

describe('new-repository destination collisions', () => {
  it.each(['create-public', 'create-private', 'list-public', 'list-private'])('refuses %s without sending file content', async (scenario) => {
    const calls: Array<{ path: string; body: unknown }> = [];
    let exists = false;
    const gh: GitHubRequest = async (path, init) => {
      calls.push({ path, body: init?.body });
      if (path === api) return exists ? reply({ default_branch: 'main', private: scenario.endsWith('private') }) : reply(null, 404);
      if (path.startsWith('/user/repos?')) {
        if (!scenario.startsWith('list')) return reply([]);
        exists = true;
        return reply([{ name: 'new-private-notes', owner: { login: 'alice' }, default_branch: 'main', private: scenario.endsWith('private'), description: null, pushed_at: '2026-10-24T00:00:00Z' }]);
      }
      if (path === '/user/repos') { exists = true; return reply({ message: 'name already exists on this account' }, 422); }
      throw new Error(`No content work is permitted: ${path}`);
    };
    await expect(author(context(gh), input)).rejects.toMatchObject({
      code: scenario.startsWith('list') ? 'FORGE_CONFLICT' : 'FORGE_VALIDATION_FAILED',
      retryable: false, message: expect.stringContaining('confirm its visibility'), details: { requestedPrivate: true, url: 'https://github.com/alice/new-private-notes' }
    });
    expect(calls.some((call) => call.path.includes('/git/') || call.path.includes('/contents/') || call.path === '/graphql')).toBe(false);
    expect(calls.filter((call) => call.path === api)).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/user/repos')).toHaveLength(scenario.startsWith('list') ? 0 : 1);
    if (scenario.startsWith('create')) expect(calls.find((call) => call.path === '/user/repos')?.body).toMatchObject({ private: true });
  });
});

function existing(unchanged = false, prFailure?: string) {
  const calls: Array<{ path: string; method: string }> = [];
  const gh: GitHubRequest = async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ path, method });
    if (path === api) return reply({ default_branch: 'main', private: false, node_id: 'repo-id' });
    if (path.includes('/git/ref/heads/')) return reply({ object: { sha: O } });
    if (path.includes('/contents/')) return reply(null, 404);
    if (path.endsWith('/git/blobs')) return reply({ sha: 'blob' }, 201);
    if (path.includes('/git/commits/')) return reply({ tree: { sha: 'base-tree' } });
    if (path.includes('/git/trees/')) return reply({ tree: [], truncated: false });
    if (path.endsWith('/git/trees')) return reply({ sha: unchanged ? 'base-tree' : 'new-tree' }, 201);
    if (path.endsWith('/git/commits')) return reply({ sha: C }, 201);
    if (path === '/graphql') return reply({ data: { updateRefs: { clientMutationId: null } } });
    if (path === `${api}/pulls` && method === 'POST') {
      if (prFailure === 'transport') throw new Error('Response lost after PR created');
      if (prFailure === 'no-diff') return reply({ message: 'No commits between branches' }, 422);
      return prFailure === 'malformed' ? reply({}, 201) : reply(null, 503);
    }
    if (path.includes('/pulls?')) return reply([]);
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { gh, calls };
}

it('preserves ordinary writes to an explicitly existing public repository', async () => {
  const fixture = existing();
  const result = await author(context(fixture.gh), input);
  expect(result.structured).toMatchObject({ commit: { outcome: 'committed', sha: C, branch: 'main' } });
  expect(fixture.calls.some((call) => call.path === '/user/repos')).toBe(false);
  expect(fixture.calls.filter((call) => call.path === '/graphql')).toHaveLength(1);
});

describe('uncertain draft PR receipts', () => {
  it.each([false, true])('preserves committed/unchanged (%s) source with honest PR uncertainty', async (unchanged) => {
    for (const failure of ['transport', 'server', 'malformed']) {
      const fixture = existing(unchanged, failure);
      const result = await author(context(fixture.gh), { ...input, change: 'Review the research' });
      expect(result.structured).toMatchObject({ commit: { outcome: unchanged ? 'unchanged' : 'committed', sha: unchanged ? O : C, branch: 'forge' }, next: expect.stringContaining('/pulls') });
      const text = JSON.stringify(result);
      expect(text).toContain('The draft PR outcome was not confirmed');
      expect(text).toContain('https://github.com/alice/new-private-notes/tree/forge');
      expect(text).toContain(`https://github.com/alice/new-private-notes/commit/${unchanged ? O : C}`);
      expect(text).not.toContain('no pull request was opened');
      expect(text).not.toContain('draft PR could not be opened');
      expect(fixture.calls.filter((call) => call.path === `${api}/pulls` && call.method === 'POST')).toHaveLength(1);
      expect(fixture.calls.some((call) => call.method === 'DELETE' || call.method === 'PATCH')).toBe(false);
    }
  });

  it('leaves an unchanged proposal ref untouched after a definite no-diff refusal', async () => {
    const fixture = existing(true, 'no-diff');
    const result = await author(context(fixture.gh), { ...input, change: 'Review the research' });
    expect(JSON.stringify(result)).toContain('Forge leaves any existing proposal ref untouched.');
    expect(JSON.stringify(result)).not.toContain('no compare-and-delete');
    expect(fixture.calls.some((call) => call.method === 'DELETE' || call.method === 'PATCH' || call.path === '/graphql')).toBe(false);
  });
});
