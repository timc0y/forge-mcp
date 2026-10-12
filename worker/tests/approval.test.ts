import { expect, it } from 'vitest';
import type { Env } from '../src/env';
import { resolveApproval } from '../src/approve';

async function approvalToken(id: string, signingKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id)));
  return btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function metadataRow(baseSha: string) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: 'user-1',
    act: 'merge',
    repo_owner: 'octocat',
    repo_name: 'hello-world',
    branch: 'forge',
    head_sha: '0123456789abcdef',
    state: 'pending',
    result_json: null,
    created_at: '2026-08-25T00:00:00.000Z',
    expires_at: '2099-08-25T00:00:00.000Z',
    resolved_at: null,
    evidence_json: JSON.stringify({
      change: { name: 'forge', branch: 'forge', number: 1, draft: true, updatedAt: '' },
      comparison: { status: 'ahead', aheadBy: 1, behindBy: 0, files: [], truncated: false },
      baseBranch: 'main',
      baseSha
    })
  };
}

function metadata(row: ReturnType<typeof metadataRow>) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() { return row; },
            async run() { return { meta: { changes: sql.includes("state = 'pending'") ? 1 : 0 } }; }
          };
        }
      };
    }
  };
}

it('marks a draft pull request ready only after the reviewed base SHA is unchanged', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const signingKey = 'test-signing-key-that-is-at-least-32-bytes';
  const baseSha = 'b'.repeat(40);
  const token = await approvalToken(id, signingKey);
  const calls: string[] = [];
  const request = async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/pulls/1')) return { status: 200, json: { base: { ref: 'main' }, head: { sha: '0123456789abcdef', ref: 'forge', repo: { full_name: 'octocat/hello-world' } }, draft: true, node_id: 'PR_node' }, text: '', headers: new Headers() };
    if (path.endsWith('/git/ref/heads/main')) return { status: 200, json: { object: { sha: baseSha } }, text: '', headers: new Headers() };
    if (path === '/graphql') return { status: 200, json: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }, text: '', headers: new Headers() };
    return { status: 200, json: { sha: 'merge-sha' }, text: '', headers: new Headers() };
  };

  const response = await resolveApproval(
    { METADATA: metadata(metadataRow(baseSha)), FORGE_SIGNING_KEY: signingKey } as unknown as Env,
    id,
    token,
    'approve',
    request
  );

  expect(calls).toEqual([
    'GET /repos/octocat/hello-world/pulls/1',
    'GET /repos/octocat/hello-world/git/ref/heads/main',
    'POST /graphql',
    'PUT /repos/octocat/hello-world/pulls/1/merge',
    'PATCH /repos/octocat/hello-world/git/refs/heads/forge'
  ]);
  expect(await response.text()).toContain('Merged');
});

it('refuses a stale proposal head before marking a draft ready', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const signingKey = 'test-signing-key-that-is-at-least-32-bytes';
  const baseSha = 'b'.repeat(40);
  const token = await approvalToken(id, signingKey);
  const calls: string[] = [];
  const request = async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/pulls/1')) return { status: 200, json: { base: { ref: 'main' }, head: { sha: 'moved-head', ref: 'forge', repo: { full_name: 'octocat/hello-world' } }, draft: true, node_id: 'PR_node' }, text: '', headers: new Headers() };
    throw new Error('no mutation or base read should occur after a stale head is observed');
  };

  const response = await resolveApproval(
    { METADATA: metadata(metadataRow(baseSha)), FORGE_SIGNING_KEY: signingKey } as unknown as Env,
    id,
    token,
    'approve',
    request
  );

  expect(calls).toEqual(['GET /repos/octocat/hello-world/pulls/1']);
  expect(await response.text()).toContain('proposal head moved');
});

it('refuses a stale approval when the reviewed base branch moved', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const signingKey = 'test-signing-key-that-is-at-least-32-bytes';
  const reviewedBase = 'b'.repeat(40);
  const movedBase = 'c'.repeat(40);
  const token = await approvalToken(id, signingKey);
  const calls: string[] = [];
  const request = async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/pulls/1')) return { status: 200, json: { base: { ref: 'main' }, head: { sha: '0123456789abcdef', ref: 'forge', repo: { full_name: 'octocat/hello-world' } }, draft: true, node_id: 'PR_node' }, text: '', headers: new Headers() };
    if (path.endsWith('/git/ref/heads/main')) return { status: 200, json: { object: { sha: movedBase } }, text: '', headers: new Headers() };
    throw new Error('merge path must not be reached');
  };

  const response = await resolveApproval(
    { METADATA: metadata(metadataRow(reviewedBase)), FORGE_SIGNING_KEY: signingKey } as unknown as Env,
    id,
    token,
    'approve',
    request
  );

  expect(calls).toEqual([
    'GET /repos/octocat/hello-world/pulls/1',
    'GET /repos/octocat/hello-world/git/ref/heads/main'
  ]);
  expect(await response.text()).toContain('reviewed diff is stale');
});

it('records a successful merge when proposal synchronization throws', async () => {
  const row = metadataRow('b'.repeat(40));
  let recorded: { ok: boolean; sha?: string; detail: string } | undefined;
  const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => row, run: async () => {
    if (sql.includes('result_json')) recorded = JSON.parse(args[1] as string);
    return { meta: { changes: 1 } };
  } }) }) };
  const request = async (path: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') throw new Error('connection dropped');
    const json = path.endsWith('/pulls/1') ? { head: { ref: 'forge', repo: { full_name: 'octocat/hello-world' }, sha: row.head_sha }, base: { ref: 'main' }, draft: false }
      : path.endsWith('/main') ? { object: { sha: 'b'.repeat(40) } } : { sha: 'merge-sha', merged: true };
    return { status: 200, json, text: '', headers: new Headers() };
  };
  await resolveApproval({ METADATA: db, FORGE_SIGNING_KEY: 'test-signing-key-that-is-at-least-32-bytes' } as unknown as Env, row.id, await approvalToken(row.id, 'test-signing-key-that-is-at-least-32-bytes'), 'approve', request);
  expect(recorded).toMatchObject({ ok: true, sha: 'merge-sha' });
  expect(recorded?.detail).toContain('check it before');
});

it('settles thrown upstream requests with an explicit uncertain result', async () => {
  const row = metadataRow('b'.repeat(40));
  let recorded: { ok: boolean; detail: string } | undefined;
  const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => row, run: async () => {
    if (sql.includes('result_json')) recorded = JSON.parse(args[1] as string);
    return { meta: { changes: 1 } };
  } }) }) };
  await resolveApproval({ METADATA: db, FORGE_SIGNING_KEY: 'test-signing-key-that-is-at-least-32-bytes' } as unknown as Env, row.id, await approvalToken(row.id, 'test-signing-key-that-is-at-least-32-bytes'), 'approve', async () => { throw new Error('upstream unavailable'); });
  expect(recorded?.ok).toBe(false);
  expect(recorded?.detail).toContain('may have changed GitHub');
});

it.each([200, 404])('rechecks a refused deletion and only treats actual absence as success (%s)', async (remainingStatus) => {
  const row = { ...metadataRow('b'.repeat(40)), act: 'discard' };
  let recorded: { ok: boolean; detail: string } | undefined;
  let reads = 0;
  const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => row, run: async () => {
    if (sql.includes('result_json')) recorded = JSON.parse(args[1] as string);
    return { meta: { changes: 1 } };
  } }) }) };
  const request = async (path: string, init?: { method?: string }) => {
    if (init?.method === 'DELETE') return { status: 422, json: { message: 'Validation failed' }, text: '', headers: new Headers() };
    if (path.includes('/git/ref/')) return { status: ++reads === 1 ? 200 : remainingStatus, json: { object: { sha: row.head_sha } }, text: '', headers: new Headers() };
    return { status: 200, json: { head: { ref: 'forge', repo: { full_name: 'octocat/hello-world' }, sha: row.head_sha } }, text: '', headers: new Headers() };
  };
  await resolveApproval({ METADATA: db, FORGE_SIGNING_KEY: 'test-signing-key-that-is-at-least-32-bytes' } as unknown as Env, row.id, await approvalToken(row.id, 'test-signing-key-that-is-at-least-32-bytes'), 'approve', request);
  expect(recorded?.ok).toBe(remainingStatus === 404);
  expect(reads).toBe(2);
});

it('refuses a fork pull request before discard closes or deletes anything', async () => {
  const row = { ...metadataRow('b'.repeat(40)), act: 'discard' };
  const methods: string[] = [];
  const request = async (path: string, init?: { method?: string }) => {
    methods.push(init?.method ?? 'GET');
    return { status: 200, json: path.includes('/git/ref/') ? { object: { sha: row.head_sha } } : { head: { ref: 'forge', repo: { full_name: 'outsider/fork' }, sha: row.head_sha } }, text: '', headers: new Headers() };
  };
  const response = await resolveApproval({ METADATA: metadata(row), FORGE_SIGNING_KEY: 'test-signing-key-that-is-at-least-32-bytes' } as unknown as Env, row.id, await approvalToken(row.id, 'test-signing-key-that-is-at-least-32-bytes'), 'approve', request);
  expect(methods).toEqual(['GET', 'GET']);
  expect(await response.text()).toContain('Nothing was discarded');
});
