import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import type { ApprovalAct, GitHubRequest } from '../src/contracts';
import { approvalPage, requestApproval, resolveApproval } from '../src/approve';

const head = 'a'.repeat(40), base = 'b'.repeat(40), moved = 'c'.repeat(40), merged = 'd'.repeat(40);
const response = (status: number, json: unknown) => ({ status, json, text: '', headers: new Headers() });
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function fixture(act: ApprovalAct = 'merge', number: number | null = 7) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users(id,github_user_id,github_login,created_at,updated_at) VALUES (?,?,?,?,?)').run('owner', 'synthetic-github-user', 'alice', now, now);
  function prepare(sql: string, values: SQLInputValue[] = []) {
    return {
      bind: (...next: SQLInputValue[]) => prepare(sql, next),
      first: async () => db.prepare(sql).get(...values) ?? null,
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } })
    };
  }
  const env = { METADATA: { prepare }, FORGE_SIGNING_KEY: 'synthetic-approval-signing-value-for-local-test', FORGE_PUBLIC_ORIGIN: 'https://forge.example' } as unknown as Env;
  const receipt = await requestApproval(env, { userId: 'owner', githubLogin: 'alice' }, {
    act, repo: { owner: 'alice', name: 'demo' },
    change: { name: 'Reviewed feature', branch: 'forge', number, draft: false, updatedAt: '' },
    comparison: { status: 'ahead', aheadBy: 1, behindBy: 0, files: [], truncated: false },
    baseBranch: 'main', baseSha: base, headSha: head
  });
  const url = new URL(receipt.url), id = url.pathname.split('/').at(-1)!, token = url.searchParams.get('t')!;
  const row = () => db.prepare('SELECT * FROM approvals WHERE id=?').get(id)!;
  const outcome = () => JSON.parse(row().result_json as string);
  const resolve = (gh: GitHubRequest, decision: 'approve' | 'reject' = 'approve') => resolveApproval(env, id, token, decision, gh);
  const page = () => approvalPage(env, id, token);
  return { db, env, id, token, row, outcome, resolve, page };
}

type ProviderOptions = { branchHead?: string; baseHead?: string; draft?: boolean; fork?: boolean; moveOnClose?: boolean; readyFailure?: number | 'malformed'; mergeFailure?: number | 'throw' | 'malformed'; closeFailure?: number | 'throw' | 'malformed'; deleteFailure?: number | 'throw' | 'malformed'; syncFailure?: boolean; all404?: boolean; pull404?: boolean; base404?: boolean };
function provider(options: ProviderOptions = {}) {
  const state = { branchHead: options.branchHead ?? head, exists: true, closed: false, merged: false, deletes: 0, syncs: 0 };
  const gh = vi.fn<GitHubRequest>(async (path, init) => {
    const method = init?.method ?? 'GET';
    if (options.all404) return response(404, {});
    if (path.endsWith('/git/ref/heads/main')) return options.base404 ? response(404, {}) : response(200, { object: { sha: options.baseHead ?? base } });
    if (path.endsWith('/git/ref/heads/forge')) return response(200, { object: { sha: state.branchHead } });
    if (path === '/repos/alice/demo') return response(200, { node_id: 'R_synthetic', full_name: 'alice/demo' });
    if (path.endsWith('/pulls/7') && method === 'GET') return options.pull404 ? response(404, {}) : response(200, {
      base: { ref: 'main' }, head: { sha: state.branchHead, ref: 'forge', repo: { full_name: options.fork ? 'other/fork' : 'alice/demo' } },
      draft: options.draft ?? false, node_id: 'PR_synthetic'
    });
    if (path.endsWith('/pulls/7') && method === 'PATCH') {
      state.closed = true;
      if (options.moveOnClose) state.branchHead = moved;
      if (options.closeFailure === 'throw') throw new Error('response lost');
      if (typeof options.closeFailure === 'number') return response(options.closeFailure, {});
      return response(200, options.closeFailure === 'malformed' ? {} : { state: 'closed' });
    }
    if (path.endsWith('/pulls/7/merge') && method === 'PUT') {
      state.merged = true;
      if (options.mergeFailure === 'throw') throw new Error('response lost');
      if (typeof options.mergeFailure === 'number') return response(options.mergeFailure, {});
      return response(200, options.mergeFailure === 'malformed' ? {} : { merged: true, sha: merged });
    }
    if (path === '/graphql' && method === 'POST') {
      const body = init?.body as { query: string; variables: Record<string, any> };
      if (body.query.includes('markPullRequestReadyForReview')) {
        if (options.readyFailure) return response(typeof options.readyFailure === 'number' ? options.readyFailure : 200, {});
        return response(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      }
      const updates = body.variables.input.refUpdates as Array<{ beforeOid: string; afterOid: string; name: string }>;
      expect(updates).toHaveLength(1);
      const update = updates[0]!;
      expect(update.beforeOid).toBe(head);
      expect(update.name).toBe('refs/heads/forge');
      if (state.branchHead !== update.beforeOid) return response(200, { data: { updateRefs: null }, errors: [{ type: 'UNPROCESSABLE', path: ['updateRefs'], message: 'beforeOid does not match' }] });
      if (update.afterOid === '0'.repeat(40)) {
        state.deletes += 1;
        state.exists = false;
        if (options.deleteFailure === 'throw') throw new Error('response lost');
        if (typeof options.deleteFailure === 'number') return response(options.deleteFailure, {});
        if (options.deleteFailure === 'malformed') return response(200, {});
      } else {
        state.syncs += 1;
        if (options.syncFailure) throw new Error('sync response lost');
        expect(update.afterOid).toBe(merged);
        state.branchHead = merged;
      }
      return response(200, { data: { updateRefs: { clientMutationId: null } } });
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  return { gh, state };
}

it('marks a draft ready only after checking the exact reviewed head and base, then atomically synchronizes it', async () => {
  const f = await fixture(), p = provider({ draft: true });
  expect(await (await f.resolve(p.gh)).text()).toContain('<h1>Merged</h1>');
  expect(p.gh.mock.calls.map(([path, init]) => `${init?.method ?? 'GET'} ${path}`)).toEqual([
    'GET /repos/alice/demo/pulls/7', 'GET /repos/alice/demo/git/ref/heads/main', 'POST /graphql',
    'PUT /repos/alice/demo/pulls/7/merge', 'GET /repos/alice/demo', 'POST /graphql'
  ]);
  expect(p.state.syncs).toBe(1);
  expect(f.outcome()).toMatchObject({ ok: true, sha: merged });
});

it.each([{ branchHead: moved }, { baseHead: moved }])('refuses a moved head/base before marking ready (%j)', async (options) => {
  const f = await fixture(), p = provider({ ...options, draft: true });
  await f.resolve(p.gh);
  expect(f.outcome().ok).toBe(false);
  expect(p.gh.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('keeps a confirmed merge receipt when branch synchronization is unconfirmed', async () => {
  const f = await fixture(), p = provider({ syncFailure: true });
  await f.resolve(p.gh);
  expect(f.outcome()).toMatchObject({ ok: true, sha: merged });
  expect(f.outcome().detail).toContain('did not confirm moving');
});

it.each([500, 'malformed'] as const)('does not claim a definite draft-readiness refusal after %s', async (readyFailure) => {
  const f = await fixture(), p = provider({ draft: true, readyFailure });
  await f.resolve(p.gh);
  expect(f.outcome()).toMatchObject({ ok: false, uncertain: true });
  expect(f.outcome().detail).toContain('No merge was requested');
  expect(p.state.merged).toBe(false);
});

it.each([500, 503, 'throw', 'malformed'] as const)('keeps a post-dispatch merge outcome unconfirmed (%s), with no replay', async (mergeFailure) => {
  const f = await fixture(), p = provider({ mergeFailure });
  const html = await (await f.resolve(p.gh)).text();
  expect(p.state.merged).toBe(true);
  expect(f.outcome()).toMatchObject({ ok: false, uncertain: true });
  expect(html).toContain('Check the outcome on GitHub');
  expect(html).not.toContain('Nothing was merged');
  const calls = p.gh.mock.calls.length;
  await f.resolve(p.gh);
  expect(p.gh).toHaveBeenCalledTimes(calls);
});

it.each([
  {
    boundary: 'pull request re-check', options: { pull404: true, draft: true }, mergeDispatched: false,
    requests: ['GET /repos/alice/demo/pulls/7']
  },
  {
    boundary: 'base branch re-check', options: { base404: true, draft: true }, mergeDispatched: false,
    requests: ['GET /repos/alice/demo/pulls/7', 'GET /repos/alice/demo/git/ref/heads/main']
  },
  {
    boundary: 'merge dispatch', options: { mergeFailure: 404 }, mergeDispatched: true,
    requests: ['GET /repos/alice/demo/pulls/7', 'GET /repos/alice/demo/git/ref/heads/main', 'PUT /repos/alice/demo/pulls/7/merge']
  }
])('persists a 404 at $boundary with inspection guidance and no replay', async ({ options, mergeDispatched, requests }) => {
  const f = await fixture(), p = provider(options);
  const immediate = await (await f.resolve(p.gh)).text();
  expect(f.row().state).toBe('failed');
  expect(f.outcome()).toMatchObject({ decision: 'approve', ok: false, uncertain: true });
  const saved = { ...f.row() };
  for (const html of [immediate, await (await f.page()).text(), await (await f.page()).text(),
    await (await f.resolve(p.gh)).text(), await (await f.resolve(p.gh, 'reject')).text()]) {
    expect(html).toContain('<h1>Check the outcome on GitHub</h1>');
    expect(html).toContain('404');
    expect(html).toContain('repository access');
    expect(html).toContain('unconfirmed');
    expect(html).toContain('this approval will not run again');
    expect(html).toContain('https://github.com/alice/demo/pull/7');
    expect(html).toContain('https://github.com/alice/demo/tree/forge');
    expect(html).not.toMatch(/Nothing was merged|<form/);
    if (mergeDispatched) {
      expect(html).toContain('GitHub may have merged the pull request');
      expect(html).not.toContain('No merge request was sent');
    } else {
      expect(html).toContain('No merge request was sent');
      expect(html).not.toMatch(/may have (merged|changed)/);
    }
  }
  expect(p.gh.mock.calls.map(([path, init]) => `${init?.method ?? 'GET'} ${path}`)).toEqual(requests);
  expect(p.state).toMatchObject({ merged: mergeDispatched, branchHead: head, closed: false, exists: true, deletes: 0, syncs: 0 });
  expect(f.row()).toEqual(saved);
});

it('retains confirmed GitHub merge refusals', async () => {
  const f = await fixture(), p = provider({ mergeFailure: 405 });
  const html = await (await f.resolve(p.gh)).text();
  expect(f.outcome()).toMatchObject({ ok: false });
  expect(f.outcome().uncertain).toBeUndefined();
  expect(html).toContain('Refused by GitHub');
});

it('atomically deletes the approved head for an ordinary discard', async () => {
  const f = await fixture('discard'), p = provider();
  expect(await (await f.resolve(p.gh)).text()).toContain('<h1>Discarded</h1>');
  expect(f.outcome().ok).toBe(true);
  expect(p.state).toMatchObject({ closed: true, exists: false, deletes: 1 });
  expect(p.gh.mock.calls.every(([, init]) => init?.method !== 'DELETE')).toBe(true);
});

it('preserves a newly pushed head and reports the already closed PR', async () => {
  const f = await fixture('discard'), p = provider({ moveOnClose: true });
  await f.resolve(p.gh);
  expect(p.state).toMatchObject({ closed: true, exists: true, branchHead: moved, deletes: 0 });
  expect(f.outcome()).toMatchObject({ ok: false });
  expect(f.outcome().detail).toMatch(/Pull request #7 was closed.*did not delete branch forge/);
});

it.each([{ branchHead: moved }, { fork: true }])('refuses a moved/fork proposal before any discard mutation (%j)', async (options) => {
  const f = await fixture('discard'), p = provider(options);
  await f.resolve(p.gh);
  expect(f.outcome().ok).toBe(false);
  expect(p.gh.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it.each([{ all404: true }, { pull404: true }])('does not turn masked private-resource 404 into successful discard (%j)', async (options) => {
  const f = await fixture('discard'), p = provider(options);
  const html = await (await f.resolve(p.gh)).text();
  expect(f.outcome()).toMatchObject({ ok: false, uncertain: true });
  expect(html).toContain('unconfirmed');
  expect(p.state).toMatchObject({ closed: false, exists: true, deletes: 0 });
  expect(p.gh.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it.each([503, 'throw', 'malformed'] as const)('reports possible PR closure without deleting the branch (%s)', async (closeFailure) => {
  const f = await fixture('discard'), p = provider({ closeFailure });
  await f.resolve(p.gh);
  expect(p.state).toMatchObject({ closed: true, exists: true, deletes: 0 });
  expect(f.outcome()).toMatchObject({ ok: false, uncertain: true });
  expect(f.outcome().detail).toContain('branch was left alone');
});

it.each([503, 'throw', 'malformed'] as const)('reports confirmed PR closure and unconfirmed branch deletion (%s)', async (deleteFailure) => {
  const f = await fixture('discard'), p = provider({ deleteFailure });
  await f.resolve(p.gh);
  expect(p.state).toMatchObject({ closed: true, exists: false, deletes: 1 });
  expect(f.outcome()).toMatchObject({ ok: false, uncertain: true });
  expect(f.outcome().detail).toMatch(/Pull request #7 was closed.*branch deletion is unconfirmed/);
  const calls = p.gh.mock.calls.length;
  await f.resolve(p.gh);
  expect(p.gh).toHaveBeenCalledTimes(calls);
});

it('allows branch-only discard with the same atomic comparison', async () => {
  const f = await fixture('discard', null), p = provider();
  await f.resolve(p.gh);
  expect(f.outcome().ok).toBe(true);
  expect(p.state).toMatchObject({ closed: false, exists: false, deletes: 1 });
});

it('claims a pending SQLite row once under concurrent approval requests', async () => {
  const f = await fixture(), p = provider();
  await Promise.all([f.resolve(p.gh), f.resolve(p.gh)]);
  expect(p.gh.mock.calls.filter(([path]) => path.endsWith('/merge'))).toHaveLength(1);
  expect(f.outcome().ok).toBe(true);
});

it('shows claimed/no-result rows as unconfirmed after interruption, expiry, and repeated opens', async () => {
  const f = await fixture();
  f.db.prepare("UPDATE approvals SET state='approved', expires_at=?, resolved_at=? WHERE id=?").run('2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', f.id);
  const gh = vi.fn<GitHubRequest>();
  for (const result of [await f.page(), await f.page(), await f.resolve(gh)]) {
    const html = await result.text();
    expect(html).toContain('outcome is unconfirmed');
    expect(html).toContain('will not run again');
    expect(html).toContain('https://github.com/alice/demo/pull/7');
    expect(html).toContain('https://github.com/alice/demo/tree/forge');
    expect(html).not.toMatch(/carrying it out now|Reload this page in a moment|<form/);
  }
  expect(gh).not.toHaveBeenCalled();
  expect(f.row().state).toBe('approved');
});

it.each([{}, { syncFailure: true }])('returns the confirmed merge when SQLite receipt storage is unconfirmed, without replay (%j)', async (options) => {
  const f = await fixture(), p = provider(options);
  f.db.exec("CREATE TRIGGER fail_result BEFORE UPDATE OF result_json ON approvals WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
  const immediate = await (await f.resolve(p.gh)).text();
  expect(immediate).toContain('<h1>Merged</h1>');
  expect(immediate).toContain(`Commit <code>${merged.slice(0, 7)}</code>`);
  expect(immediate).toContain('https://github.com/alice/demo/pull/7');
  expect(immediate).toContain('Receipt storage was not confirmed.');
  expect(immediate).toContain('This approval will not run again.');
  expect(immediate).toContain('Resolved on ');
  expect(immediate).not.toMatch(/no saved result|storage failed|receipt was saved|<form/);
  expect(immediate).not.toContain('opening it again just shows this page');
  if (options.syncFailure) expect(immediate).toContain('did not confirm moving');
  expect(p.state.merged).toBe(true);
  expect(f.row()).toMatchObject({ state: 'approved', result_json: null });
  const claimed = { ...f.row() };
  f.db.exec('DROP TRIGGER fail_result');
  const calls = p.gh.mock.calls.length;
  for (const result of [await f.page(), await f.page(), await f.resolve(p.gh), await f.resolve(p.gh, 'reject')]) {
    const html = await result.text();
    expect(html).toContain('outcome is unconfirmed');
    expect(html).toContain('will not run again');
    expect(html).not.toMatch(/<h1>Merged<\/h1>|<form/);
  }
  expect(p.gh).toHaveBeenCalledTimes(calls);
  expect(p.gh.mock.calls.filter(([path]) => path.endsWith('/merge'))).toHaveLength(1);
  expect(f.row()).toEqual(claimed);
});

it.each<{
  label: string; act: ApprovalAct; decision: 'approve' | 'reject'; options: ProviderOptions;
  heading: string; detail: string; mergeDispatched?: boolean; closed?: boolean; deletes?: number;
}>([
  { label: 'confirmed discard', act: 'discard', decision: 'approve', options: {}, heading: 'Discarded', detail: 'pull request #7 is closed and the branch was deleted', closed: true, deletes: 1 },
  { label: 'rejected merge', act: 'merge', decision: 'reject', options: {}, heading: 'Not merged', detail: 'Not merged. The change is untouched' },
  { label: 'rejected discard', act: 'discard', decision: 'reject', options: {}, heading: 'Not discarded', detail: 'Not discarded. The change is untouched' },
  { label: 'confirmed merge refusal', act: 'merge', decision: 'approve', options: { mergeFailure: 405 }, heading: 'Not merged', detail: 'Refused by GitHub', mergeDispatched: true },
  { label: 'pull request 404 before dispatch', act: 'merge', decision: 'approve', options: { pull404: true }, heading: 'Check the outcome on GitHub', detail: 'No merge request was sent' },
  { label: 'base 404 before dispatch', act: 'merge', decision: 'approve', options: { base404: true }, heading: 'Check the outcome on GitHub', detail: 'No merge request was sent' },
  { label: 'merge 404 after dispatch', act: 'merge', decision: 'approve', options: { mergeFailure: 404 }, heading: 'Check the outcome on GitHub', detail: 'GitHub may have merged the pull request', mergeDispatched: true },
  { label: 'merge response lost', act: 'merge', decision: 'approve', options: { mergeFailure: 'throw' }, heading: 'Check the outcome on GitHub', detail: 'The operation may have changed GitHub', mergeDispatched: true },
  { label: 'discard deletion unconfirmed', act: 'discard', decision: 'approve', options: { deleteFailure: 'malformed' }, heading: 'Check the outcome on GitHub', detail: 'Pull request #7 was closed, but branch deletion is unconfirmed', closed: true, deletes: 1 }
])('returns the known $label when SQLite receipt storage is unconfirmed, without replay', async ({ act, decision, options, heading, detail, mergeDispatched, closed, deletes }) => {
  const f = await fixture(act), p = provider(options);
  f.db.exec("CREATE TRIGGER fail_result BEFORE UPDATE OF result_json ON approvals WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
  const immediate = await (await f.resolve(p.gh, decision)).text();
  expect(immediate).toContain(`<h1>${heading}</h1>`);
  expect(immediate).toContain(detail);
  expect(immediate).toContain('Receipt storage was not confirmed.');
  expect(immediate).toContain('This approval will not run again.');
  expect(immediate).toContain('Resolved on ');
  expect(immediate).not.toMatch(/<h1>Merged<\/h1>|Commit <code>|no saved result|storage failed|receipt was saved|<form/);
  expect(immediate).not.toContain('opening it again just shows this page');
  if (options.pull404 || options.base404) expect(immediate).not.toMatch(/may have (merged|changed)/);
  if (options.mergeFailure === 404) expect(immediate).not.toContain('No merge request was sent');
  expect(p.state).toMatchObject({ closed: closed ?? false, deletes: deletes ?? 0 });
  expect(p.gh.mock.calls.filter(([path]) => path.endsWith('/merge'))).toHaveLength(mergeDispatched ? 1 : 0);
  const claimed = { ...f.row() };
  expect(claimed).toMatchObject({ state: decision === 'reject' ? 'rejected' : 'approved', result_json: null });
  f.db.exec('DROP TRIGGER fail_result');
  const calls = p.gh.mock.calls.length;
  for (const result of [await f.page(), await f.page(), await f.resolve(p.gh), await f.resolve(p.gh, 'reject')]) {
    const html = await result.text();
    expect(html).toContain('outcome is unconfirmed');
    expect(html).toContain('will not run again');
    expect(html).not.toContain('<form');
  }
  expect(p.gh).toHaveBeenCalledTimes(calls);
  if (decision === 'reject') expect(p.gh).not.toHaveBeenCalled();
  expect(f.row()).toEqual(claimed);
});

it('keeps storage unconfirmed when SQLite writes the merge receipt before raising an error', async () => {
  const f = await fixture(), p = provider();
  f.db.exec("CREATE TRIGGER fail_result AFTER UPDATE OF result_json ON approvals WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(FAIL,'synthetic receipt acknowledgement failure'); END;");
  const immediate = await (await f.resolve(p.gh)).text();
  expect(immediate).toContain('<h1>Merged</h1>');
  expect(immediate).toContain(`Commit <code>${merged.slice(0, 7)}</code>`);
  expect(immediate).toContain('https://github.com/alice/demo/pull/7');
  expect(immediate).toContain('Receipt storage was not confirmed.');
  expect(immediate).not.toMatch(/storage failed|receipt was saved|<form/);
  expect(f.outcome()).toMatchObject({ ok: true, sha: merged });
  const saved = { ...f.row() }, calls = p.gh.mock.calls.length;
  const resolvedAt = new Date(saved.resolved_at as string).toUTCString();
  for (const html of [immediate, await (await f.page()).text(), await (await f.page()).text(),
    await (await f.resolve(p.gh)).text(), await (await f.resolve(p.gh, 'reject')).text()]) {
    expect(html).toContain('<h1>Merged</h1>');
    expect(html).toContain(`Resolved on ${resolvedAt}`);
    expect(html).not.toContain('outcome is unconfirmed');
  }
  expect(p.gh).toHaveBeenCalledTimes(calls);
  expect(f.row()).toEqual(saved);
});

it('renders the persisted resolution time immediately and on later opens', async () => {
  const f = await fixture();
  f.db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run('2099-01-01T00:00:00Z', f.id);
  const gh = vi.fn<GitHubRequest>();
  const immediate = await (await f.resolve(gh, 'reject')).text();
  const later = await (await f.page()).text();
  const resolvedAt = new Date(f.row().resolved_at as string).toUTCString();
  expect(immediate).toContain(`Resolved on ${resolvedAt}`);
  expect(later).toContain(`Resolved on ${resolvedAt}`);
  expect(immediate).not.toContain('2099');
  expect(gh).not.toHaveBeenCalled();
});

it('labels actual expiry separately from resolution without dispatch', async () => {
  const f = await fixture();
  f.db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z', f.id);
  const gh = vi.fn<GitHubRequest>();
  const html = await (await f.resolve(gh)).text();
  expect(html).toContain('Expired on Sat, 01 Jan 2000');
  expect(html).not.toContain('Resolved');
  expect(f.row().state).toBe('expired');
  expect(gh).not.toHaveBeenCalled();
});
