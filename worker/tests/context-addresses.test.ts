import { describe, expect, it } from 'vitest';
import { githubAddress } from '../src/addresses';
import type { GitHubRequest } from '../src/contracts';

const SHA = 'a'.repeat(40);
const reply = (json: unknown, status = 200) => ({ status, json, text: '', headers: new Headers() });

describe('canonical GitHub source addresses', () => {
  it('accepts commit-pinned blobs and preserves exact line anchors without API guessing', async () => {
    let calls = 0;
    const gh: GitHubRequest = async () => { calls++; return reply(null, 404); };
    const result = await githubAddress(gh, `https://github.com/o/r/blob/${SHA}/src/a.ts#L2-L4`);
    expect(result).toEqual({ repo: { owner: 'o', name: 'r' }, at: SHA, paths: ['src/a.ts:2-4'] });
    expect(calls).toBe(0);
  });

  it('resolves slash-containing branch names from GitHub ref identities', async () => {
    const calls: string[] = [];
    const gh: GitHubRequest = async (path) => {
      calls.push(path);
      if (path.includes('/matching-refs/heads/feature')) return reply([{ ref: 'refs/heads/feature/foo', object: { sha: SHA } }]);
      if (path.includes('/matching-refs/tags/feature')) return reply([]);
      return reply(null, 404);
    };
    const result = await githubAddress(gh, 'https://github.com/o/r/blob/feature/foo/src/a.ts#L7');
    expect(result).toEqual({ repo: { owner: 'o', name: 'r' }, at: 'refs/heads/feature/foo', paths: ['src/a.ts:7-7'] });
    expect(calls).toHaveLength(2);
  });

  it('refuses a blob URL that is ambiguous between a branch and tag', async () => {
    const gh: GitHubRequest = async (path) =>
      reply([{ ref: path.includes('/heads/') ? 'refs/heads/release/v1' : 'refs/tags/release/v1', object: { sha: SHA } }]);
    await expect(githubAddress(gh, 'https://github.com/o/r/blob/release/v1/src/a.ts')).rejects.toMatchObject({ code: 'FORGE_AMBIGUOUS' });
  });

  it('rejects incomplete repository URLs and unsafe pull numbers before GitHub lookup', async () => {
    const gh: GitHubRequest = async () => { throw new Error('GitHub must not be called'); };
    await expect(githubAddress(gh, 'https://github.com/owner')).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
    await expect(githubAddress(gh, 'https://github.com/o/r/pull/999999999999999999999999')).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
  });

  it('accepts same-repository pull heads case-insensitively and refuses fork widening', async () => {
    const same: GitHubRequest = async () => reply({ head: { sha: SHA, repo: { full_name: 'O/R' } } });
    await expect(githubAddress(same, 'https://github.com/o/r/pull/12')).resolves.toEqual({ repo: { owner: 'o', name: 'r' }, at: SHA, pull: 12 });
    const fork: GitHubRequest = async () => reply({ head: { sha: SHA, repo: { full_name: 'someone/fork' } } });
    await expect(githubAddress(fork, 'https://github.com/o/r/pull/12')).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
  });
});
