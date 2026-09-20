import { describe, expect, it } from 'vitest';
import { applyReplacements, commitFiles } from '../src/write';
import type { GitHubRequest } from '../src/contracts';
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
  it('refuses whitespace and CRLF substitutions rather than normalizing offsets', () => {
    for (const old of ['  const x = 1;', 'const x = 1;\r\n']) expect(() => applyReplacements('a.ts', 'const x = 1;\n', [{ old, new: 'const x = 2;' }])).toThrow(/absent/);
  });
  it('rejects repeated occurrences unless all was explicitly requested', () => {
    expect(() => applyReplacements('a.ts', 'x x', [{ old: 'x', new: 'y' }])).toThrow(/more than once/);
    expect(applyReplacements('a.ts', 'x x', [{ old: 'x', new: 'y', all: true }])).toBe('y y');
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
