import { afterEach, describe, expect, it, vi } from 'vitest';
import { reserveSemantic, completeSemantic } from '../src/semantic-budget';
import { evaluate } from '../src/semantics';
import { RequestBudget } from '../src/evidence';
import { semanticEnv } from './helpers/semantic-db';
import type { Env } from '../src/env';

afterEach(() => vi.restoreAllMocks());
describe('shared paid inference admission', () => {
  it('admits only the simultaneous allowance across concurrent callers', async () => {
    const env = semanticEnv({ FORGE_SEMANTIC_MAX_CONCURRENCY: '2' });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => reserveSemantic(env)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(await env.METADATA.prepare('SELECT attempts, unknown FROM semantic_usage').first()).toMatchObject({ attempts: 2, unknown: 2 });
    expect(await env.METADATA.prepare('SELECT count(*) AS count FROM semantic_reservations').first()).toMatchObject({ count: 2 });
  });
  it('releases completed requests but never refunds daily attempts', async () => {
    const env = semanticEnv({ FORGE_SEMANTIC_DAILY_CALL_LIMIT: '2', FORGE_SEMANTIC_MAX_CONCURRENCY: '1' });
    const first = await reserveSemantic(env);
    expect(await completeSemantic(env, first, { inputTokens: 10, outputTokens: 2 })).toBe(true);
    expect(await completeSemantic(env, first, { inputTokens: 10, outputTokens: 2 })).toBe(false);
    await completeSemantic(env, await reserveSemantic(env), null);
    await expect(reserveSemantic(env)).rejects.toMatchObject({ code: 'FORGE_QUOTA_EXCEEDED' });
    expect(await env.METADATA.prepare('SELECT * FROM semantic_usage').first()).toMatchObject({ attempts: 2, completed: 2, unknown: 0, input_tokens: 10, output_tokens: 2 });
  });
  it('quarantines an unknown request until expiry, retaining its daily charge', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T12:00:00Z'));
    const env = semanticEnv({ FORGE_SEMANTIC_MAX_CONCURRENCY: '1' });
    await reserveSemantic(env);
    now.mockReturnValue(Date.parse('2026-10-23T12:00:59Z'));
    await expect(reserveSemantic(env)).rejects.toMatchObject({ code: 'FORGE_QUOTA_EXCEEDED' });
    now.mockReturnValue(Date.parse('2026-10-23T12:01:00Z'));
    await reserveSemantic(env);
    expect(await env.METADATA.prepare('SELECT attempts, unknown FROM semantic_usage').first()).toMatchObject({ attempts: 2, unknown: 2 });
  });
  it('fails before provider egress when allowance storage or configuration is missing/broken', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    const env = semanticEnv();
    for (const bad of [{ ...env, METADATA: undefined }, { ...env, FORGE_SEMANTIC_DAILY_CALL_LIMIT: '0' }, { ...env, METADATA: { prepare() { throw new Error('private database detail'); } } }]) {
      await expect(evaluate(bad as Env, {}, { q: { type: 'noul', instructions: 'Relevant?' } }, 'budget/v1', new RequestBudget())).rejects.toThrow(/allowance/);
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('counts timed-out and malformed provider responses without refund', async () => {
    const env = semanticEnv();
    const request = vi.spyOn(globalThis, 'fetch');
    const question = { q: { type: 'noul' as const, instructions: 'Relevant?' } };
    request.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    await expect(evaluate(env, {}, question, 'budget/v1', new RequestBudget())).rejects.toThrow(/transport failed/);
    request.mockResolvedValueOnce(Response.json({ success: true, errors: [], result: { state: 'Completed', result: { model: 'jev-1.13.0', answers: {} } } }));
    await expect(evaluate(env, {}, question, 'budget/v1', new RequestBudget())).rejects.toThrow(/answer set/);
    expect(await env.METADATA.prepare('SELECT attempts, completed, unknown FROM semantic_usage').first()).toMatchObject({ attempts: 2, completed: 0, unknown: 2 });
  });
  it('rolls back a reservation if its aggregate cannot be charged', async () => {
    const env = semanticEnv();
    const db = env.METADATA;
    env.METADATA = {
      prepare(sql: string) { return db.prepare(sql.startsWith('INSERT INTO semantic_usage') ? 'INSERT INTO nonexistent_table VALUES (?1, ?2)' : sql); },
      batch: db.batch.bind(db)
    } as D1Database;
    await expect(reserveSemantic(env)).rejects.toMatchObject({ code: 'FORGE_UPSTREAM_UNAVAILABLE' });
    expect(await db.prepare('SELECT count(*) AS count FROM semantic_reservations').first()).toMatchObject({ count: 0 });
    expect(await db.prepare('SELECT count(*) AS count FROM semantic_usage').first()).toMatchObject({ count: 0 });
  });
  it('returns validated evidence promptly when completion accounting stalls', async () => {
    vi.useFakeTimers();
    try {
      const env = semanticEnv();
      const db = env.METADATA;
      let batches = 0;
      env.METADATA = { prepare: db.prepare.bind(db), batch: (statements: D1PreparedStatement[]) => ++batches === 1 ? db.batch(statements) : new Promise(() => {}) } as D1Database;
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true, errors: [], result: { state: 'Completed', result: { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } } } } }));
      const budget = new RequestBudget(100);
      const evaluating = evaluate(env, {}, { q: { type: 'noul', instructions: 'Relevant?' } }, 'budget/v1', budget);
      await vi.advanceTimersByTimeAsync(25);
      expect(await evaluating).toMatchObject({ accounting: 'unknown', answers: { q: { noul: 0.9 } } });
      expect(budget.remaining()).toBe(75);
      expect(await db.prepare('SELECT attempts, completed, unknown FROM semantic_usage').first()).toMatchObject({ attempts: 1, completed: 0, unknown: 1 });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('does not contact inference if shared admission exceeds the remaining deadline', async () => {
    vi.useFakeTimers();
    try {
      const env = semanticEnv();
      env.METADATA.batch = () => new Promise(() => {});
      const request = vi.spyOn(globalThis, 'fetch');
      const evaluating = evaluate(env, {}, { q: { type: 'noul', instructions: 'Relevant?' } }, 'budget/v1', new RequestBudget(100));
      const rejected = expect(evaluating).rejects.toThrow(/allowance could not be reserved/);
      await vi.advanceTimersByTimeAsync(100); await rejected;
      expect(request).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
