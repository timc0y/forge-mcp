import { describe, expect, it } from 'vitest';
import type { GitHubRequest } from '../src/contracts';
import { deleteRefIfUnchanged, updateRefIfUnchanged } from '../src/github-refs';

const repo = { owner: 'o', name: 'r' };
const before = 'a'.repeat(40), after = 'b'.repeat(40), other = 'c'.repeat(40);
const reply = (json: unknown, status = 200) => ({ json, status, text: '', headers: new Headers() });
const accepted = () => reply({ data: { updateRefs: { clientMutationId: null } } });
const rejected = () => reply({ data: { updateRefs: null }, errors: [{ type: 'UNPROCESSABLE', path: ['updateRefs'] }] });

describe('atomic GitHub ref changes', () => {
  it.each([false, true])('binds update/deletion (%s) to the expected OID through the supplied gh', async (deleting) => {
    const calls: Array<{ path: string; init: Parameters<GitHubRequest>[1] }> = [];
    const signal = new AbortController().signal;
    const gh: GitHubRequest = async (path, init) => {
      calls.push({ path, init });
      return path === '/repos/o/r' ? reply({ node_id: 'user-authorized-repo' }) : accepted();
    };
    if (deleting) await deleteRefIfUnchanged(gh, repo, 'forge/review', before, { signal });
    else await updateRefIfUnchanged(gh, repo, 'forge/review', before, after, { signal });
    expect(calls.map((call) => call.path)).toEqual(['/repos/o/r', '/graphql']);
    expect(calls[1]?.init).toMatchObject({
      method: 'POST', signal,
      body: { query: expect.stringContaining('updateRefs'), variables: { input: {
        repositoryId: 'user-authorized-repo', refUpdates: [{ name: 'refs/heads/forge/review', beforeOid: before, afterOid: deleting ? '0'.repeat(40) : after, force: false }]
      } } }
    });
    expect((calls[1]?.init?.body as any).variables.input).not.toHaveProperty('clientMutationId');
  });

  it.each([false, true])('does not update/delete a concurrent push (%s) or retry it', async (deleting) => {
    let live: string | null = before, mutations = 0;
    const gh: GitHubRequest = async (path, init) => {
      if (path === '/repos/o/r') return reply({ node_id: 'repo' });
      mutations++;
      live = other;
      const input = (init!.body as any).variables.input.refUpdates[0];
      if (live !== input.beforeOid) return rejected();
      live = input.afterOid === '0'.repeat(40) ? null : input.afterOid;
      return accepted();
    };
    const result = deleting ? deleteRefIfUnchanged(gh, repo, 'forge', before) : updateRefIfUnchanged(gh, repo, 'forge', before, after);
    await expect(result).rejects.toMatchObject({ code: 'FORGE_CONFLICT', retryable: false, details: { refUpdate: 'rejected' } });
    expect(live).toBe(other);
    expect(mutations).toBe(1);
  });

  it.each([
    reply(null, 503), reply({ data: { updateRefs: {} } }), reply({ data: { updateRefs: null } }),
    reply({ data: { updateRefs: { clientMutationId: 'wrong-response-id' } } }),
    reply({ data: { updateRefs: { clientMutationId: '' } } }),
    reply({ data: { updateRefs: { clientMutationId: null } }, errors: [{ type: 'INTERNAL', path: ['updateRefs'] }] }),
    reply({ data: { updateRefs: null }, errors: [{ type: 'INTERNAL', path: ['updateRefs'] }] }),
    reply({ data: { updateRefs: null }, errors: [{ type: 'UNPROCESSABLE', path: ['unexpected'] }] })
  ])('keeps an ambiguous mutation response uncertain', async (response) => {
    let mutations = 0;
    const gh: GitHubRequest = async (path) => {
      if (path === '/repos/o/r') return reply({ node_id: 'repo' });
      mutations++;
      return response;
    };
    await expect(updateRefIfUnchanged(gh, repo, 'forge', before, after)).rejects.toMatchObject({
      retryable: false, details: { refUpdate: 'uncertain', sha: after, url: `https://github.com/o/r/commit/${after}`, branchUrl: 'https://github.com/o/r/tree/forge' }
    });
    expect(mutations).toBe(1);
  });

  it('retains an uncertain deletion when the response is lost after it takes effect', async () => {
    let live: string | null = before, mutations = 0;
    const gh: GitHubRequest = async (path) => {
      if (path === '/repos/o/r') return reply({ node_id: 'repo' });
      mutations++;
      live = null;
      throw new Error('Response lost after deletion');
    };
    await expect(deleteRefIfUnchanged(gh, repo, 'forge', before)).rejects.toMatchObject({ retryable: false, details: { refUpdate: 'uncertain', sha: before } });
    expect(live).toBeNull();
    expect(mutations).toBe(1);
  });

  it.each([reply(null, 404), reply({}), reply({ node_id: 'repo' }, 503)])('does not dispatch after a failed identity lookup', async (response) => {
    const calls: string[] = [];
    const gh: GitHubRequest = async (path) => { calls.push(path); return response; };
    await expect(updateRefIfUnchanged(gh, repo, 'forge', before, after)).rejects.toMatchObject({ details: { refUpdate: 'not_dispatched' } });
    expect(calls).toEqual(['/repos/o/r']);
  });

  it('does not dispatch a mutation after aborting an unresponsive identity lookup', async () => {
    const controller = new AbortController(), calls: string[] = [];
    let finish: (response: Awaited<ReturnType<GitHubRequest>>) => void = () => {};
    const gh: GitHubRequest = async (path) => { calls.push(path); return new Promise((resolve) => { finish = resolve; }); };
    const result = updateRefIfUnchanged(gh, repo, 'forge', before, after, { signal: controller.signal });
    const check = expect(result).rejects.toMatchObject({ details: { refUpdate: 'not_dispatched' } });
    controller.abort();
    await check;
    finish(reply({ node_id: 'repo' }));
    await Promise.resolve();
    expect(calls).toEqual(['/repos/o/r']);
  });

  it('bounds an unresponsive dispatched mutation with the supplied signal', async () => {
    const controller = new AbortController();
    let entered: () => void = () => {};
    const dispatched = new Promise<void>((resolve) => { entered = resolve; });
    const gh: GitHubRequest = async (path) => {
      if (path === '/repos/o/r') return reply({ node_id: 'repo' });
      entered();
      return new Promise(() => {});
    };
    const result = updateRefIfUnchanged(gh, repo, 'forge', before, after, { signal: controller.signal });
    const check = expect(result).rejects.toMatchObject({ retryable: false, details: { refUpdate: 'uncertain' } });
    await dispatched;
    controller.abort();
    await check;
  });
});
