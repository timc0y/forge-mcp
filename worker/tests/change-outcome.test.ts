import { expect, it, vi } from 'vitest';
import { ensureDraftPullRequest } from '../src/change';
import type { GitHubRequest } from '../src/contracts';

const response = (status: number, json: unknown) => ({ status, json, text: '', headers: new Headers() });
const repo = { owner: 'alice', name: 'demo' };

it.each(['transport', 500, 503, 'malformed-created'] as const)('does not retry or deny possible PR creation after %s', async (failure) => {
  let created = false;
  const request = vi.fn<GitHubRequest>(async (_path, init) => {
    if (init?.method !== 'POST') return response(200, []);
    created = true;
    if (failure === 'transport') throw new Error('response lost');
    return response(typeof failure === 'number' ? failure : 201, {});
  });
  await expect(ensureDraftPullRequest(request, repo, 'forge', 'Review this', 'main')).rejects.toMatchObject({
    code: 'FORGE_UPSTREAM_UNAVAILABLE', retryable: false,
    details: { branch: 'forge', pullRequestCreation: 'uncertain' },
    message: expect.stringMatching(/unconfirmed.*may have opened it.*inspect.*did not retry/)
  });
  expect(created).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});

it('retains ordinary successful PR creation', async () => {
  const request: GitHubRequest = async (_path, init) => init?.method === 'POST'
    ? response(201, { number: 7, head: { ref: 'forge' }, draft: true })
    : response(200, []);
  await expect(ensureDraftPullRequest(request, repo, 'forge', 'Review this', 'main')).resolves.toBe(7);
});
