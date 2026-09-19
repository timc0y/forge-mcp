import { describe, expect, it } from 'vitest';
import type { GitHubRequest } from '../src/contracts';
import {
  readBranchPolicy,
  readCodeownersErrors,
  readPullReviewState,
  readRecentChurn,
  readRecentHistory
} from '../src/github-intelligence';

function requestFor(reviews: unknown[]): GitHubRequest {
  return async (path) => {
    if (path.endsWith('/pulls/7')) {
      return {
        status: 200,
        json: { mergeable: true, draft: false },
        text: '',
        headers: new Headers()
      };
    }
    if (path.includes('/pulls/7/reviews')) {
      return {
        status: 200,
        json: reviews,
        text: '',
        headers: new Headers()
      };
    }
    return { status: 404, json: null, text: '', headers: new Headers() };
  };
}

const repo = { owner: 'o', name: 'r' };

describe('recent history', () => {
  it('does not claim older history merely because one full page was returned', async () => {
    const request: GitHubRequest = async () => ({
      status: 200,
      json: [
        {
          sha: 'abc123',
          commit: {
            message: 'only commit',
            author: { name: 'Dev', date: '2026-09-01T10:00:00Z' },
            committer: { name: 'Dev', date: '2026-09-01T10:00:00Z' }
          }
        }
      ],
      text: '',
      headers: new Headers()
    });

    const history = await readRecentHistory(request, repo, 'main', undefined, 1);
    expect(history.commits).toHaveLength(1);
    expect(history.truncated).toBe(false);
  });

  it('marks a malformed successful history response unavailable instead of empty', async () => {
    const request: GitHubRequest = async () => ({
      status: 200,
      json: { commits: [] },
      text: '',
      headers: new Headers()
    });

    const history = await readRecentHistory(request, repo, 'main');
    expect(history.commits).toEqual([]);
    expect(history.unavailable).toContain('unreadable commit history');
  });

  it('uses GitHub pagination as the evidence that older history exists', async () => {
    const headers = new Headers({
      Link: '<https://api.github.com/repositories/1/commits?page=2>; rel="next"'
    });
    const request: GitHubRequest = async () => ({
      status: 200,
      json: [
        {
          sha: 'abc123',
          commit: {
            message: 'newest',
            author: { name: 'Dev', date: '2026-09-01T10:00:00Z' },
            committer: { name: 'Dev', date: '2026-09-01T10:00:00Z' }
          }
        }
      ],
      text: '',
      headers
    });

    const history = await readRecentHistory(request, repo, 'main', undefined, 1);
    expect(history.truncated).toBe(true);
  });
});

describe('recent churn', () => {
  it('preserves successful churn while disclosing failed commit-detail reads', async () => {
    const request: GitHubRequest = async (path) => {
      if (path.includes('/commits?')) {
        return {
          status: 200,
          json: [
            { sha: 'good111', commit: { message: 'good', author: { date: '2026-09-01T00:00:00Z' } } },
            { sha: 'bad222', commit: { message: 'bad', author: { date: '2026-09-02T00:00:00Z' } } }
          ],
          text: '',
          headers: new Headers()
        };
      }
      if (path.includes('/commits/good111')) {
        return {
          status: 200,
          json: { files: [{ filename: 'src/a.ts', additions: 3, deletions: 1 }] },
          text: '',
          headers: new Headers()
        };
      }
      return { status: 500, json: null, text: '', headers: new Headers() };
    };

    const churn = await readRecentChurn(request, repo, 'main', 2);
    expect(churn.entries).toEqual([{ path: 'src/a.ts', touches: 1, additions: 3, deletions: 1 }]);
    expect(churn.unavailable).toContain('1 of 2 commit-detail lookups were unavailable');
  });
});

describe('branch and ownership evidence', () => {
  it('marks malformed branch-rule data unavailable instead of no rules', async () => {
    const request: GitHubRequest = async () => ({
      status: 200,
      json: { rules: [] },
      text: '',
      headers: new Headers()
    });
    const policy = await readBranchPolicy(request, repo, 'main');
    expect(policy.rules).toEqual([]);
    expect(policy.unavailable).toContain('unreadable branch-rules');
  });

  it('marks malformed CODEOWNERS data unavailable instead of no errors', async () => {
    const request: GitHubRequest = async () => ({
      status: 200,
      json: {},
      text: '',
      headers: new Headers()
    });
    const result = await readCodeownersErrors(request, repo, 'main');
    expect(result.errors).toEqual([]);
    expect(result.unavailable).toContain('readable error list');
  });
});

describe('pull review state', () => {
  it('keeps an approval when the same reviewer later leaves a comment', async () => {
    const state = await readPullReviewState(
      requestFor([
        { state: 'APPROVED', user: { login: 'alice' } },
        { state: 'COMMENTED', user: { login: 'alice' } }
      ]),
      repo,
      7
    );

    expect(state.approvals).toBe(1);
    expect(state.changesRequested).toBe(0);
    expect(state.comments).toBe(1);
  });

  it('lets a later decisive review replace an earlier decisive review', async () => {
    const state = await readPullReviewState(
      requestFor([
        { state: 'CHANGES_REQUESTED', user: { login: 'alice' } },
        { state: 'APPROVED', user: { login: 'alice' } }
      ]),
      repo,
      7
    );

    expect(state.approvals).toBe(1);
    expect(state.changesRequested).toBe(0);
  });

  it('marks malformed pull and review records as partial evidence', async () => {
    const request: GitHubRequest = async (path) => {
      if (path.endsWith('/pulls/7')) {
        return { status: 200, json: ['bad-pull-shape'], text: '', headers: new Headers() };
      }
      return {
        status: 200,
        json: [
          null,
          { state: 'APPROVED', user: { login: 'alice' } }
        ],
        text: '',
        headers: new Headers()
      };
    };

    const state = await readPullReviewState(request, repo, 7);
    expect(state.approvals).toBe(1);
    expect(state.unavailable).toContain('unreadable pull-request state');
    expect(state.unavailable).toContain('1 unreadable record');
  });

  it('clears a reviewer decision when GitHub reports it dismissed', async () => {
    const state = await readPullReviewState(
      requestFor([
        { state: 'APPROVED', user: { login: 'alice' } },
        { state: 'DISMISSED', user: { login: 'alice' } }
      ]),
      repo,
      7
    );

    expect(state.approvals).toBe(0);
    expect(state.changesRequested).toBe(0);
  });
});
