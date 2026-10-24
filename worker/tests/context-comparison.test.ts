import { describe, expect, it } from 'vitest';
import { compare, listRepos } from '../src/read';
import { readRepository } from '../src/repository-reader';
import type { GitHubRequest } from '../src/contracts';
import type { ToolContext } from '../src/tool-types';

const sha = 'a'.repeat(40);
const reply = (json: unknown) => ({ status: 200, json, text: '', headers: new Headers() });
const comparison = (count: number) => ({ status: 'ahead', ahead_by: 1, behind_by: 0, files: Array.from({ length: count }, (_, index) => ({ filename: `src/f${index}.ts`, status: 'modified', additions: 1, deletions: 1 })) });

describe('changed-file coverage', () => {
  it.each([[299, false], [300, true]])('reports the GitHub file ceiling without needing commit pagination (%i files)', async (count, incomplete) => {
    const gh: GitHubRequest = async () => reply(comparison(count as number));
    expect((await compare(gh, { owner: 'o', name: 'r' }, sha, 'b'.repeat(40))).truncated).toBe(incomplete);
  });

  it('names the local 200-file omission independently of GitHub completeness', async () => {
    const gh: GitHubRequest = async (path) => {
      if (path.startsWith('/repos/o/r/pulls?')) return reply([{ number: 1, head: { ref: 'forge', repo: { full_name: 'o/r' } }, draft: true, title: 'forge', updated_at: '' }]);
      if (path === '/repos/o/r') return reply({ default_branch: 'main', private: false });
      if (path.startsWith('/repos/o/r/commits/')) return reply({ sha });
      if (path.startsWith('/repos/o/r/compare/')) return reply(comparison(201));
      throw new Error(`Unexpected request: ${path}`);
    };
    const ctx = { gh, identity: { githubLogin: 'o' } } as ToolContext;
    const result = await readRepository(ctx, { repo: 'o/r', change: 'forge', query: 'diff' });
    expect((result.structured.diff as { files: unknown[] }).files).toHaveLength(200);
    expect(result.structured.limits).toEqual(['Returned change files are bounded to 200 of 201 files provided by GitHub.']);
  });
});

describe('user-token repository discovery', () => {
  const repository = { name: 'r', owner: { login: 'o' }, description: null, default_branch: 'main', private: true, pushed_at: '2026-10-12T00:00:00Z' };
  it('uses the user-token endpoint and preserves repository output', async () => {
    const calls: string[] = [];
    const gh: GitHubRequest = async (path) => { calls.push(path); return reply([repository]); };
    expect(await listRepos(gh)).toEqual([{ repo: 'o/r', description: null, defaultBranch: 'main', private: true, pushedAt: repository.pushed_at }]);
    expect(calls).toEqual(['/user/repos?per_page=100&page=1&sort=full_name']);
  });
  it('follows a next-page link even when GitHub returns a short page', async () => {
    const calls: string[] = [];
    const gh: GitHubRequest = async (path) => {
      calls.push(path);
      return calls.length === 1 ? { ...reply([repository]), headers: new Headers({ link: '<https://api.github.com/user/repos?page=2>; rel="next"' }) } : reply([]);
    };
    expect(await listRepos(gh)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
  it('refuses absence conclusions when repository pagination exceeds the bound', async () => {
    const gh: GitHubRequest = async () => ({ ...reply(Array.from({ length: 100 }, () => repository)), headers: new Headers({ link: '<https://api.github.com/user/repos?page=11>; rel="next"' }) });
    await expect(listRepos(gh, 'absent')).rejects.toMatchObject({ code: 'FORGE_QUOTA_EXCEEDED' });
  });

  it.each([0, 999, 1000])('returns all %i repositories when the last page has no next link', async (count) => {
    const calls: string[] = [];
    const gh: GitHubRequest = async (path) => {
      calls.push(path);
      const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page'));
      const start = (page - 1) * 100;
      const rows = Array.from({ length: Math.max(0, Math.min(100, count - start)) }, (_, i) => ({ ...repository, name: `r${start + i}` }));
      const link = start + rows.length < count ? `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"` : '<https://api.github.com/user/repos?page=1>; rel="first"';
      return { ...reply(rows), headers: new Headers({ link }) };
    };
    const result = await listRepos(gh);
    expect(result).toHaveLength(count);
    expect(new Set(result.map((entry) => entry.repo)).size).toBe(count);
    expect(calls).toHaveLength(Math.max(1, Math.ceil(count / 100)));
  });

  it('stops at a complete full page without requesting an eleventh page or inventing more results', async () => {
    let calls = 0;
    const gh: GitHubRequest = async () => { calls++; return reply(Array.from({ length: 100 }, () => repository)); };
    expect(await listRepos(gh)).toHaveLength(100);
    expect(calls).toBe(1);
  });

  it('refuses a 1,001-repository result rather than returning a filtered or truncated list', async () => {
    let calls = 0;
    const gh: GitHubRequest = async () => {
      calls++;
      if (calls > 10) throw new Error('Discovery must stay within ten pages');
      return { ...reply(Array.from({ length: 100 }, () => repository)), headers: new Headers({ link: `<https://api.github.com/user/repos?page=${calls + 1}>; rel="next"` }) };
    };
    await expect(listRepos(gh, 'absent')).rejects.toMatchObject({ code: 'FORGE_QUOTA_EXCEEDED' });
    expect(calls).toBe(10);
  });
});
