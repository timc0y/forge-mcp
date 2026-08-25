import { expect, it } from 'vitest';
import type { Env } from '../src/env';
import { resolveApproval } from '../src/approve';

it('marks a draft pull request ready before merging it', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const signingKey = 'test-signing-key-that-is-at-least-32-bytes';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id)));
  const token = btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const row = {
    id, user_id: 'user-1', act: 'merge', repo_owner: 'octocat', repo_name: 'hello-world',
    branch: 'forge/test', head_sha: '0123456789abcdef', state: 'pending', result_json: null,
    created_at: '2026-08-25T00:00:00.000Z', expires_at: '2099-08-25T00:00:00.000Z', resolved_at: null,
    evidence_json: JSON.stringify({
      change: { name: 'test', branch: 'forge/test', number: 1, draft: true, updatedAt: '' },
      comparison: { status: 'ahead', aheadBy: 1, behindBy: 0, files: [], truncated: false },
      baseBranch: 'main'
    })
  };
  const metadata = { prepare(sql: string) { return { bind() { return {
    async first() { return row; },
    async run() { return { meta: { changes: sql.includes("state = 'pending'") ? 1 : 0 } }; }
  }; } }; } };
  const calls: string[] = [];
  const request = async (path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/pulls/1')) return { status: 200, json: { base: { ref: 'main' }, draft: true, node_id: 'PR_node' }, text: '', headers: new Headers() };
    if (path === '/graphql') return { status: 200, json: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }, text: '', headers: new Headers() };
    return { status: 200, json: { sha: 'merge-sha' }, text: '', headers: new Headers() };
  };

  const response = await resolveApproval({ METADATA: metadata, FORGE_SIGNING_KEY: signingKey } as unknown as Env, id, token, 'approve', request);

  expect(calls).toEqual([
    'GET /repos/octocat/hello-world/pulls/1',
    'POST /graphql',
    'PUT /repos/octocat/hello-world/pulls/1/merge'
  ]);
  expect(await response.text()).toContain('Merged');
});
