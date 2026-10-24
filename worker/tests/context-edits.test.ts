import { describe, expect, it } from 'vitest';
import { applyReplacements, commitFiles } from '../src/write';
import type { GitHubRequest } from '../src/contracts';
import { author } from '../src/authoring';
import type { ToolContext } from '../src/tool-types';
import type { Env } from '../src/env';
const sha = 'a'.repeat(40);
const repo = { owner: 'o', name: 'r' };
function github(source: string): { request: GitHubRequest; calls: string[] } {
  const calls: string[] = [];
  const request: GitHubRequest = async (path, init) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    let json: unknown = null;
    if (path.includes('/git/ref/heads/')) json = { object: { sha } };
    if (path.includes('/contents/')) json = { type: 'file', encoding: 'base64', content: btoa(source), size: source.length };
    return { status: json ? 200 : 404, json, text: '', headers: new Headers() };
  };
  return { request, calls };
}
describe('exact candidate editing', () => {
  it.each([
    [{ path: '../a.ts', content: 'export const value = 1;' }, 'writable path'],
    [{ path: 'a.ts', content: 'function run( {' }, 'parser errors'],
    [{ path: 'a.txt', content: 'ghp_' + 'a'.repeat(36) }, 'secret']
  ])('refuses invalid authored content before creating a repository', async (file, reason) => {
    const calls: string[] = [];
    const request: GitHubRequest = async (path) => { calls.push(path); throw new Error('No GitHub request should occur'); };
    const ctx: ToolContext = { env: {} as Env, identity: { userId: 'u', githubLogin: 'o', installationId: '1' }, track: () => {}, gh: request, ghUser: request };
    await expect(author(ctx, { repo: 'o/new', message: 'Create source', files: [file] })).rejects.toThrow(reason);
    expect(calls).toEqual([]);
  });

  it('reports durable repository creation when the subsequent file write fails', async () => {
    const calls: string[] = [];
    let created = false;
    const request: GitHubRequest = async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      const response = (status: number, json: unknown) => ({ status, json, text: '', headers: new Headers() });
      if (path === '/repos/o/new') return response(created ? 200 : 404, created ? { default_branch: 'main' } : null);
      if (path.startsWith('/user/repos?')) return response(200, []);
      if (path === '/user/repos') { created = true; return response(201, { owner: { login: 'o' }, name: 'new' }); }
      if (path === '/repos/o/new/git/ref/heads/main') return response(200, { object: { sha } });
      if (path.includes('/contents/')) return response(404, null);
      if (path === '/repos/o/new/git/blobs') return response(503, { message: 'Temporary failure' });
      return response(404, null);
    };
    const ctx: ToolContext = { env: {} as Env, identity: { userId: 'u', githubLogin: 'o', installationId: '1' }, track: () => {}, gh: request, ghUser: request };
    await expect(author(ctx, { repo: 'o/new', message: 'Create source', files: [{ path: 'a.ts', content: 'export const value = 1;' }] })).rejects.toMatchObject({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: expect.stringContaining('Created https://github.com/o/new before the requested write failed'),
      retryable: false,
      details: { createdRepository: 'o/new', url: 'https://github.com/o/new' }
    });
    expect(calls).toContain('POST /user/repos');
    expect(calls).toContain('POST /repos/o/new/git/blobs');
    expect(calls.some((call) => call.startsWith('DELETE '))).toBe(false);
  });

  it('refuses whitespace and CRLF substitutions rather than normalizing offsets', () => {
    for (const old of ['  const x = 1;', 'const x = 1;\r\n']) expect(() => applyReplacements('a.ts', 'const x = 1;\n', [{ old, new: 'const x = 2;' }])).toThrow(/absent/);
  });
  it('rejects repeated occurrences unless all was explicitly requested', () => {
    expect(() => applyReplacements('a.ts', 'x x', [{ old: 'x', new: 'y' }])).toThrow(/more than once/);
    expect(applyReplacements('a.ts', 'x x', [{ old: 'x', new: 'y', all: true }])).toBe('y y');
  });
  it.each([
    ['banana', 'ana', 'bXna'],
    ['aaaa', 'aa', 'XX']
  ])('rejects overlapping matches in %s unless all was explicitly requested', (source, old, allResult) => {
    expect(() => applyReplacements('a.txt', source, [{ old, new: 'X' }])).toThrow(/more than once/);
    expect(applyReplacements('a.txt', source, [{ old, new: 'X', all: true }])).toBe(allResult);
  });
  it('refuses an overlapping fragment before creating any blob', async () => {
    const gh = github('banana');
    await expect(commitFiles(gh.request, repo, 'main', 'main', 'edit', [{ path: 'a.txt', replace: [{ old: 'ana', new: 'X' }] }])).rejects.toMatchObject({
      code: 'FORGE_VALIDATION_FAILED', details: { reason: 'repeated' }
    });
    expect(gh.calls.some((call) => call.startsWith('POST '))).toBe(false);
  });
  it('refuses a stale source selector before creating any blob', async () => {
    const gh = github('function run() {}');
    await expect(commitFiles(gh.request, repo, 'main', 'main', 'edit', [{ path: 'a.ts', edit: { expectedCommit: 'b'.repeat(40), selector: 'a.ts::symbol:run', replacement: 'function run() { return 1; }' } }])).rejects.toMatchObject({ code: 'FORGE_CONFLICT' });
    expect(gh.calls.some((call) => call.startsWith('POST '))).toBe(false);
  });
  it('refuses parser-invalid candidate contents before any blob write', async () => {
    const gh = github('function run() {}');
    await expect(commitFiles(gh.request, repo, 'main', 'main', 'edit', [{ path: 'a.ts', replace: [{ old: 'function run() {}', new: 'function run( {' }] }])).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
    expect(gh.calls.some((call) => call.startsWith('POST '))).toBe(false);
  });
});
