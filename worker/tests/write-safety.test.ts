import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubRequest } from '../src/contracts';
import { commitFiles } from '../src/write';

const repo = { owner: 'o', name: 'r' };
const api = '/repos/o/r';
const head = 'a'.repeat(40);
const commit = 'c'.repeat(40);
const files = [{ path: 'a.md', content: 'after' }];
const reply = (json: unknown, status = 200) => ({ json, status, text: '', headers: new Headers() });
type Response = Awaited<ReturnType<GitHubRequest>>;
type Call = { path: string; method: string; init: Parameters<GitHubRequest>[1]; at: number };

function github(intercept?: (call: Call) => Response | Promise<Response> | undefined, missingBranch = false) {
  const calls: Call[] = [];
  const request: GitHubRequest = async (path, init) => {
    const call = { path, method: init?.method ?? 'GET', init, at: Date.now() };
    calls.push(call);
    const intercepted = intercept?.(call);
    if (intercepted !== undefined) return intercepted;
    if (path === `${api}/git/ref/heads/forge` && missingBranch) return reply(null, 404);
    if (path.includes('/git/ref/heads/')) return reply({ object: { sha: head } });
    if (path === `${api}/git/refs`) return reply({ object: { sha: head } }, 201);
    if (path.includes('/contents/')) return reply({ type: 'file', size: 6, encoding: 'base64', content: btoa('before') });
    if (path === `${api}/git/blobs`) return reply({ sha: 'blob' }, 201);
    if (path === `${api}/git/commits/${head}`) return reply({ tree: { sha: 'base-tree' } });
    if (path === `${api}/git/trees/base-tree`) return reply({ tree: [{ path: 'a.md', type: 'blob', mode: '100644', sha: 'old-blob' }], truncated: false });
    if (path === `${api}/git/trees`) return reply({ sha: 'new-tree' }, 201);
    if (path === `${api}/git/commits`) return reply({ sha: commit }, 201);
    if (init?.method === 'PATCH') return reply({ object: { sha: commit } });
    throw new Error(`Unexpected fixture request: ${call.method} ${path}`);
  };
  return { request, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('legacy branch name conflicts', () => {
  it.each([false, true])('preserves an unused legacy branch, including a concurrent push (%s)', async (concurrent) => {
    let legacyHead: string | null = head;
    const advanced = 'b'.repeat(40);
    const gh = github((call) => {
      if (call.path === `${api}/git/refs`) return reply({ message: 'Reference update failed' }, 422);
      if (call.path === `${api}/git/matching-refs/heads/forge`) {
        const listed = [{ ref: 'refs/heads/forge/older', object: { sha: legacyHead } }, { ref: 'refs/heads/forge-other' }];
        if (concurrent) queueMicrotask(() => { legacyHead = advanced; });
        return reply(listed);
      }
      if (call.path.includes('/compare/')) return reply({ ahead_by: legacyHead === head ? 0 : 1 });
      if (call.method === 'DELETE') { legacyHead = null; return reply(null, 204); }
      return undefined;
    }, true);

    await expect(commitFiles(gh.request, repo, 'forge', 'main', 'edit', files)).rejects.toMatchObject({
      code: 'FORGE_CONFLICT',
      message: expect.stringContaining('merging or renaming'),
      details: { branches: ['forge/older'] }
    });
    expect(legacyHead).toBe(concurrent ? advanced : head);
    expect(gh.calls.some((call) => call.method === 'DELETE' || call.path.includes('/compare/'))).toBe(false);
    expect(gh.calls.filter((call) => call.path === `${api}/git/refs`)).toHaveLength(1);
  });

  it('preserves the fixed branch on an unchanged write', async () => {
    const gh = github((call) => call.path === `${api}/git/trees` ? reply({ sha: 'base-tree' }, 201) : undefined);
    await expect(commitFiles(gh.request, repo, 'forge', 'main', 'edit', files)).resolves.toMatchObject({ outcome: 'unchanged', branch: 'forge', sha: head });
    expect(gh.calls.some((call) => call.method === 'DELETE' || call.method === 'PATCH')).toBe(false);
  });
});

describe('write deadline before the durable ref update', () => {
  it('refuses a concurrent modification of the same file before a second commit', async () => {
    let reads = 0;
    const moved = 'b'.repeat(40);
    const gh = github((call) => {
      if (call.path === `${api}/git/ref/heads/main`) return reply({ object: { sha: ++reads === 1 ? head : moved } });
      if (call.method === 'PATCH') return reply({}, 422);
      if (call.path === `${api}/git/commits/${moved}`) return reply({ tree: { sha: 'moved-tree' } });
      if (call.path.includes('/compare/')) return reply({ files: [{ filename: 'a.md', status: 'modified' }] });
      return undefined;
    });
    await expect(commitFiles(gh.request, repo, 'main', 'main', 'edit', files)).rejects.toMatchObject({ code: 'FORGE_CONFLICT' });
    expect(gh.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(gh.calls.filter((call) => call.path === `${api}/git/commits`)).toHaveLength(1);
  });

  it('returns an inspectable uncertain result when PATCH never answers', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let signal: AbortSignal | undefined;
    const gh = github((call) => {
      if (call.method === 'PATCH') { signal = call.init?.signal; return new Promise<Response>(() => {}); }
      return undefined;
    });
    const writing = commitFiles(gh.request, repo, 'main', 'main', 'edit', files);
    const rejected = expect(writing).rejects.toMatchObject({ retryable: false, message: expect.stringContaining(`/commit/${commit}`), details: { refUpdate: 'uncertain' } });
    await vi.advanceTimersByTimeAsync(55_000);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(gh.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    ['branch read', `${api}/git/ref/heads/main`],
    ['content read', `${api}/contents/a.md?ref=${head}`],
    ['blob creation', `${api}/git/blobs`],
    ['commit read', `${api}/git/commits/${head}`],
    ['mode read', `${api}/git/trees/base-tree`],
    ['tree creation', `${api}/git/trees`],
    ['commit creation', `${api}/git/commits`]
  ])('does not update the branch after a slow %s', async (_, slowPath) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gh = github((call) => {
      if (call.path === slowPath) vi.setSystemTime(65_000);
      return undefined;
    });
    await expect(commitFiles(gh.request, repo, 'main', 'main', 'edit', files)).rejects.toMatchObject({
      code: 'FORGE_UPSTREAM_UNAVAILABLE', message: expect.stringContaining('file changes were not applied')
    });
    expect(gh.calls.some((call) => call.method === 'PATCH' || call.at >= 40_000)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight read at the remaining deadline and never resumes into a write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let signal: AbortSignal | undefined;
    let finish: ((response: Response) => void) | undefined;
    const gh = github((call) => {
      if (call.path === `${api}/git/blobs`) vi.setSystemTime(35_000);
      if (call.path === `${api}/git/commits/${head}`) {
        signal = call.init?.signal;
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return undefined;
    });
    const writing = commitFiles(gh.request, repo, 'main', 'main', 'edit', files);
    const rejected = expect(writing).rejects.toMatchObject({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: expect.stringContaining('unattached blobs, trees or commits') });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.aborted).toBe(true);
    finish!(reply({ tree: { sha: 'base-tree' } }));
    await Promise.resolve();
    expect(gh.calls.some((call) => call.method === 'PATCH' || call.path === `${api}/git/trees/base-tree`)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('reports a branch creation that finished after the deadline (%s)', async (confirmed) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gh = github((call) => {
      if (call.path !== `${api}/git/refs`) return undefined;
      if (!confirmed) return new Promise<Response>(() => {});
      vi.setSystemTime(65_000);
      return reply({ object: { sha: head } }, 201);
    }, true);
    const writing = commitFiles(gh.request, repo, 'forge', 'main', 'edit', files);
    const rejected = expect(writing).rejects.toMatchObject({
      code: 'FORGE_UPSTREAM_UNAVAILABLE', retryable: false,
      message: expect.stringContaining(confirmed ? `Created forge at ${head}` : 'outcome is not confirmed'),
      details: { branchCreation: { branch: 'forge', sha: confirmed ? head : null } }
    });
    if (!confirmed) await vi.advanceTimersByTimeAsync(40_000);
    await rejected;
    expect(gh.calls.some((call) => call.method === 'PATCH' || call.path.includes('/contents/'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks the deadline immediately before dispatching PATCH', async () => {
    let dispatches = 0;
    const gh = github((call) => { if (call.method === 'PATCH') dispatches += 1; return undefined; });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const request: GitHubRequest = async (path, init) => {
      const response = await gh.request(path, init);
      if (path === `${api}/git/commits`) clock.mockReturnValueOnce(0).mockReturnValue(40_000);
      return response;
    };
    await expect(commitFiles(request, repo, 'main', 'main', 'edit', files)).rejects.toMatchObject({ code: 'FORGE_UPSTREAM_UNAVAILABLE' });
    expect(dispatches).toBe(0);
  });

  it('keeps a confirmed PATCH successful after the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gh = github((call) => {
      if (call.method === 'PATCH') vi.setSystemTime(65_000);
      return undefined;
    });
    await expect(commitFiles(gh.request, repo, 'main', 'main', 'edit', files)).resolves.toMatchObject({ outcome: 'committed', sha: commit });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['lost response', 'server error', 'wrong head'])('preserves an uncertain PATCH outcome after %s', async (failure) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gh = github((call) => {
      if (call.method !== 'PATCH') return undefined;
      vi.setSystemTime(65_000);
      if (failure === 'lost response') throw new Error('Response lost after GitHub applied the ref');
      if (failure === 'server error') return reply({ message: 'Response failed' }, 503);
      return reply({ object: { sha: head } });
    });
    const error = await commitFiles(gh.request, repo, 'main', 'main', 'edit', files).catch((thrown) => thrown);
    expect(error).toMatchObject({
      code: 'FORGE_UPSTREAM_UNAVAILABLE', retryable: false,
      message: expect.stringContaining('Read the branch before writing again'),
      details: { sha: commit, refUpdate: 'uncertain' }
    });
    expect(error.message).not.toMatch(/nothing was committed|write again when|not applied/i);
    expect(gh.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
