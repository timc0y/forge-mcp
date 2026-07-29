import { describe, expect, it } from 'vitest';
import type { GitHubRequest } from '@forge/git-github';
import { readPullRequestReadiness } from '../../apps/forge-edge-gateway/src/github-pr-readiness';

function github(overrides: Record<string, { status: number; json: unknown }> = {}): GitHubRequest {
  const defaults: Record<string, { status: number; json: unknown }> = {
    '/repos/acme/app/pulls/7': { status: 200, json: { number: 7, title: 'Ready', state: 'open', mergeable: true, mergeable_state: 'clean', head: { sha: 'head' }, base: { ref: 'main' } } },
    '/repos/acme/app/commits/head/check-runs?per_page=100&page=1': { status: 200, json: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] } },
    '/repos/acme/app/commits/head/statuses?per_page=100&page=1': { status: 200, json: [{ context: 'legacy-ci', state: 'success' }] },
    '/repos/acme/app/pulls/7/reviews?per_page=100&page=1': { status: 200, json: [{ state: 'APPROVED', user: { login: 'reviewer' } }] },
    '/repos/acme/app/branches/main': { status: 200, json: { protected: true } },
    '/repos/acme/app/branches/main/protection': { status: 200, json: { required_pull_request_reviews: { required_approving_review_count: 1 }, required_status_checks: { contexts: ['build', 'legacy-ci'] } } }
  };
  return async (path) => overrides[path] ?? defaults[path] ?? { status: 404, json: {} };
}

describe('readPullRequestReadiness', () => {
  it('is safe only with successful checks, statuses, required reviews, and a clean merge state', async () => {
    const status = await readPullRequestReadiness(github(), '/repos/acme/app', 7);
    expect(status).toMatchObject({ safe_to_merge: true, review_decision: 'APPROVED' });
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
      '/repos/acme/app/commits/head/statuses?per_page=100&page=1': { status: 200, json: [{ context: 'legacy-ci', state: 'failure' }] },
      '/repos/acme/app/pulls/7/reviews?per_page=100&page=1': { status: 200, json: [] }
    }), '/repos/acme/app', 7);
    expect(status.safe_to_merge).toBe(false);
    expect(status.review_decision).toBe('REVIEW_REQUIRED');
    expect(status.blockers.join(' ')).toMatch(/legacy-ci.*Requires 1 approving review/u);
  });

  it('uses only the newest classic status for each context', async () => {
    const status = await readPullRequestReadiness(github({
      '/repos/acme/app/commits/head/statuses?per_page=100&page=1': {
        status: 200,
        json: [
          { context: 'legacy-ci', state: 'success' },
          { context: 'legacy-ci', state: 'failure' }
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
