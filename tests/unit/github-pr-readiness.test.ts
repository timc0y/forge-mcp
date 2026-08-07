import { describe, expect, it } from 'vitest';
import type { GitHubRequest } from '@forge/git-github';
import { deferredMergeQueueBlockers, readPullRequestReadiness } from '../../apps/forge-edge-gateway/src/github-repository';

function github(overrides: Record<string, { status: number; json: unknown }> = {}): GitHubRequest {
  const defaults: Record<string, { status: number; json: unknown }> = {
    '/repos/acme/app/pulls/7': { status: 200, json: { number: 7, title: 'Ready', body: 'Body', html_url: 'https://github.com/acme/app/pull/7', draft: false, state: 'open', mergeable: true, mergeable_state: 'clean', head: { sha: 'head', ref: 'feature' }, base: { ref: 'main' } } },
    '/repos/acme/app/commits/head/check-runs?per_page=100&page=1': { status: 200, json: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] } },
    '/repos/acme/app/commits/head/statuses?per_page=100&page=1': { status: 200, json: [{ context: 'required-ci', state: 'success' }] },
    '/repos/acme/app/pulls/7/reviews?per_page=100&page=1': { status: 200, json: [{ state: 'APPROVED', user: { login: 'reviewer' } }] },
    '/repos/acme/app/branches/main': { status: 200, json: { protected: true } },
    '/repos/acme/app/branches/main/protection': { status: 200, json: { required_pull_request_reviews: { required_approving_review_count: 1 }, required_status_checks: { contexts: ['build', 'required-ci'] } } }
  };
  return async (path) => overrides[path] ?? defaults[path] ?? { status: 404, json: {} };
}

describe('readPullRequestReadiness', () => {
  it('is safe only with successful checks, statuses, required reviews, and a clean merge state', async () => {
    const status = await readPullRequestReadiness(github(), '/repos/acme/app', 7);
    expect(status).toMatchObject({ safe_to_merge: true, review_decision: 'APPROVED' });
    expect(status).toMatchObject({ body: 'Body', url: 'https://github.com/acme/app/pull/7', draft: false, head_ref: 'feature', base_ref: 'main' });
    expect(status.checks).toMatchObject({ total: 2, passed: 2, failed: 0, pending: 0 });
  });

  it('fails closed when any evidence endpoint fails', async () => {
    const status = await readPullRequestReadiness(github({
      '/repos/acme/app/commits/head/statuses?per_page=100&page=1': { status: 503, json: {} }
    }), '/repos/acme/app', 7);
    expect(status.safe_to_merge).toBe(false);
    expect(status.blockers).toContain('Classic status evidence unavailable (HTTP 503).');
  });

  it('blocks classic status failures and missing required reviews', async () => {
    const status = await readPullRequestReadiness(github({
      '/repos/acme/app/commits/head/statuses?per_page=100&page=1': { status: 200, json: [{ context: 'required-ci', state: 'failure' }] },
      '/repos/acme/app/pulls/7/reviews?per_page=100&page=1': { status: 200, json: [] }
    }), '/repos/acme/app', 7);
    expect(status.safe_to_merge).toBe(false);
    expect(status.review_decision).toBe('REVIEW_REQUIRED');
    expect(status.blockers.join(' ')).toMatch(/required-ci.*Requires 1 approving review/u);
  });

  it('uses only the newest classic status for each context', async () => {
    const status = await readPullRequestReadiness(github({
      '/repos/acme/app/commits/head/statuses?per_page=100&page=1': {
        status: 200,
        json: [
          { context: 'required-ci', state: 'success' },
          { context: 'required-ci', state: 'failure' }
        ]
      }
    }), '/repos/acme/app', 7);
    expect(status.safe_to_merge).toBe(true);
    expect(status.checks).toMatchObject({ total: 2, passed: 2, failed: 0 });
  });

  it('blocks a GitHub blocked merge state even when checks and reviews pass', async () => {
    const status = await readPullRequestReadiness(github({
      '/repos/acme/app/pulls/7': { status: 200, json: { number: 7, title: 'Blocked', state: 'open', mergeable: true, mergeable_state: 'blocked', head: { sha: 'head' }, base: { ref: 'main' } } }
    }), '/repos/acme/app', 7);
    expect(status.safe_to_merge).toBe(false);
    expect(status.blockers).toContain('GitHub mergeable state is blocked, not clean.');
  });

  it('keeps draft status explicit so an approved deferred merge can make it ready later', async () => {
    const status = await readPullRequestReadiness(github({
      '/repos/acme/app/pulls/7': {
        status: 200,
        json: {
          number: 7,
          title: 'Draft',
          body: 'Draft body',
          html_url: 'https://github.com/acme/app/pull/7',
          draft: true,
          state: 'open',
          mergeable: true,
          mergeable_state: 'draft',
          head: { sha: 'head', ref: 'feature' },
          base: { ref: 'main' }
        }
      }
    }), '/repos/acme/app', 7);
    expect(status).toMatchObject({ draft: true, head_ref: 'feature', base_ref: 'main', safe_to_merge: false });
    expect(status.blockers).toContain('Still a draft.');
  });

  it('only removes draft-transition blockers when queueing a draft merge', () => {
    expect(deferredMergeQueueBlockers({
      draft: true,
      blockers: [
        'Still a draft.',
        'GitHub mergeable verdict is null.',
        'GitHub mergeable state is draft, not clean.',
        'Required status context(s) not successful: build.'
      ]
    })).toEqual(['Required status context(s) not successful: build.']);
    expect(deferredMergeQueueBlockers({
      draft: true,
      blockers: ['GitHub mergeable verdict is false.', 'GitHub mergeable state is blocked, not clean.']
    })).toEqual(['GitHub mergeable state is blocked, not clean.']);
  });

  it('preserves permanent pull-request read failures as actionable Forge errors', async () => {
    await expect(readPullRequestReadiness(github({
      '/repos/acme/app/pulls/7': { status: 404, json: {} }
    }), '/repos/acme/app', 7)).rejects.toMatchObject({ code: 'FORGE_FILE_NOT_FOUND', retryable: false });
    await expect(readPullRequestReadiness(github({
      '/repos/acme/app/pulls/7': { status: 403, json: {} }
    }), '/repos/acme/app', 7)).rejects.toMatchObject({ code: 'FORGE_PERMISSION_DENIED', retryable: false });
  });

  it('reports changes requested from the latest effective reviews', async () => {
    const status = await readPullRequestReadiness(github({
      '/repos/acme/app/pulls/7/reviews?per_page=100&page=1': { status: 200, json: [
        { state: 'APPROVED', user: { login: 'reviewer' } },
        { state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } }
      ] }
    }), '/repos/acme/app', 7);
    expect(status.review_decision).toBe('CHANGES_REQUESTED');
    expect(status.safe_to_merge).toBe(false);
  });
});
