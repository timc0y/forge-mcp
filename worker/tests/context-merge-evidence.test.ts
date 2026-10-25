import { describe, expect, it } from 'vitest';
import { mergeEvidence, requireMergeEvidence } from '../src/merge-evidence';
import type { GitHubRequest } from '../src/contracts';
import type { Snapshot } from '../src/snapshot';

function report(overrides: Record<string, unknown> = {}) {
  return {
    blockers: [],
    checks: { coverage: 'complete', checks: [{ kind: 'check-run', status: 'completed', conclusion: 'success' }], workflows: [] },
    policy: { unavailable: undefined, truncated: false },
    reviews: { unavailable: undefined, truncated: false, mergeable: true },
    ...overrides
  } as any;
}

describe('merge evidence gate', () => {
  it('requires complete successful exact-head execution even without required branch checks', () => {
    expect(() => requireMergeEvidence(report({ checks: { coverage: 'unavailable', checks: [], workflows: [] } }))).toThrow(/exact-head check evidence/);
    expect(() => requireMergeEvidence(report({ checks: { coverage: 'bounded', checks: [], workflows: [] } }))).toThrow(/exact-head check evidence/);
    expect(() => requireMergeEvidence(report({ checks: { coverage: 'complete', checks: [], workflows: [] } }))).toThrow(/all-success execution evidence/);
    expect(() => requireMergeEvidence(report({ checks: { coverage: 'complete', checks: [{ kind: 'check-run', status: 'completed', conclusion: 'neutral' }], workflows: [] } }))).toThrow(/all-success execution evidence/);
  });

  it('refuses known blockers and unavailable policy', () => {
    expect(() => requireMergeEvidence(report({ blockers: ['Check verify: failure'] }))).toThrow(/known blockers/);
    expect(() => requireMergeEvidence(report({ policy: { unavailable: '403', truncated: false } }))).toThrow(/policy could not be established/);
  });

  it('refuses missing, truncated or unresolved pull-request state', () => {
    expect(() => requireMergeEvidence(report({ reviews: null }))).toThrow(/review or mergeability/);
    expect(() => requireMergeEvidence(report({ reviews: { unavailable: undefined, truncated: true, mergeable: true } }))).toThrow(/review or mergeability/);
    expect(() => requireMergeEvidence(report({ reviews: { unavailable: undefined, truncated: false, mergeable: null } }))).toThrow(/review or mergeability/);
  });

  it('permits approval preparation only when required evidence is complete and blocker-free', () => {
    expect(() => requireMergeEvidence(report())).not.toThrow();
  });
});

async function githubReport(parameters: Record<string, unknown> = {}, reviews?: unknown[]) {
  const sha = 'a'.repeat(40);
  const gh: GitHubRequest = async (path) => {
    const json = path.includes('/check-runs?') ? { total_count: 1, check_runs: [{ id: 1, name: 'verify', head_sha: sha, status: 'completed', conclusion: 'success' }] }
      : path.includes('/status?') ? { sha, total_count: 0, statuses: [] }
        : path.includes('/rules/branches/') ? (Object.keys(parameters).length ? [{ type: 'pull_request', parameters }] : [])
          : path.includes('/reviews?') ? (reviews ?? [{ state: 'APPROVED', user: { login: 'alice' }, commit_id: 'b'.repeat(40) }])
            : { mergeable: true, mergeable_state: 'blocked', draft: false };
    return { status: 200, json, text: '', headers: new Headers() };
  };
  return mergeEvidence({ gh, repo: { owner: 'alice', name: 'demo' }, branch: 'main', identity: { sha } } as Snapshot,
    { status: 'ahead', aheadBy: 1, behindBy: 0, files: [], truncated: false }, 7);
}

describe('enabled GitHub review requirements', () => {
  it.each([
    ['require_code_owner_review', 'Code-owner review'],
    ['require_last_push_approval', 'Approval of the latest push'],
    ['required_review_thread_resolution', 'Review-thread resolution']
  ])('refuses unsupported proof for %s despite generic approval counts', async (rule, reason) => {
    const result = await githubReport({ required_approving_review_count: 1, [rule]: true });
    expect(result.reviews?.approvals).toBe(1);
    expect(result.blockers).toContainEqual(expect.stringContaining(reason));
    expect(() => requireMergeEvidence(result)).toThrow(/Complete this merge on GitHub/);
  });

  it('reports each enabled rule without claiming local approval proves it', async () => {
    const result = await githubReport({ require_code_owner_review: true, require_last_push_approval: true, required_review_thread_resolution: true });
    expect(result.blockers).toHaveLength(3);
    expect(result.blockers.every((blocker) => blocker.includes('authoritative GitHub proof'))).toBe(true);
  });

  it('does not count null reviewers toward a two-person requirement', async () => {
    const result = await githubReport({ required_approving_review_count: 2 }, [
      { state: 'APPROVED', user: null }, { state: 'APPROVED', user: null }
    ]);
    expect(result.reviews?.approvals).toBe(0);
    expect(result.reviews?.unavailable).toContain('without reviewer identity');
    expect(() => requireMergeEvidence(result)).toThrow(/Required independent GitHub approvals/);
  });

  it('preserves ordinary policy-free and named-review successful preparation', async () => {
    const ordinary = await githubReport();
    expect(() => requireMergeEvidence(ordinary)).not.toThrow();
    const named = await githubReport({ required_approving_review_count: 2 }, [
      { state: 'APPROVED', user: { login: 'alice' } }, { state: 'APPROVED', user: { login: 'bob' } }
    ]);
    expect(() => requireMergeEvidence(named)).not.toThrow();
  });
});
