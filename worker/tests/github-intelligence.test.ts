import { describe, expect, it } from 'vitest';
import type { GitHubRequest } from '../src/contracts';
import { readPullReviewState, readRecentHistory } from '../src/github-intelligence';

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
