import type { Env } from './env';
import { ForgeError } from './errors';

const QUARANTINE_MS = 60_000;
function limit(value: string | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number) || number > ceiling) {
    throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The shared semantic allowance is misconfigured. No inference request was sent.' });
  }
  return number;
}

export interface SemanticReservation { id: string; day: string }

async function boundedBatch(env: Env, statements: D1PreparedStatement[], milliseconds: number): Promise<D1Result[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([env.METADATA.batch(statements), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

/** D1 batch is one transaction; concurrent Workers cannot spend the same slot. */
export async function reserveSemantic(env: Env, milliseconds = 40_000): Promise<SemanticReservation> {
  const daily = limit(env.FORGE_SEMANTIC_DAILY_CALL_LIMIT, 200, 100_000);
  const concurrent = limit(env.FORGE_SEMANTIC_MAX_CONCURRENCY, 4, 64);
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const id = crypto.randomUUID();
  let results: D1Result[];
  try {
    if (milliseconds <= 0) throw new Error('No admission time remains');
    const completed = await boundedBatch(env, [
      env.METADATA.prepare('DELETE FROM semantic_reservations WHERE expires_at <= ?1').bind(now),
      env.METADATA.prepare(`INSERT INTO semantic_reservations (id, expires_at)
        SELECT ?1, ?2 WHERE
          COALESCE((SELECT attempts FROM semantic_usage WHERE day = ?3), 0) < ?4
          AND (SELECT count(*) FROM semantic_reservations) < ?5`).bind(id, now + QUARANTINE_MS, day, daily, concurrent),
      env.METADATA.prepare(`INSERT INTO semantic_usage (day, attempts, unknown)
        SELECT ?1, 1, 1 WHERE EXISTS (SELECT 1 FROM semantic_reservations WHERE id = ?2)
        ON CONFLICT(day) DO UPDATE SET attempts = attempts + 1, unknown = unknown + 1`).bind(day, id)
    ], milliseconds);
    if (!completed) throw new Error('Admission time expired');
    results = completed;
    if (results.some((result) => !result.success)) throw new Error('Admission transaction failed');
  } catch {
    throw new ForgeError({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: 'The shared semantic allowance could not be reserved. No inference request was sent.' });
  }
  if (results[1]?.meta.changes !== 1) {
    throw new ForgeError({ code: 'FORGE_QUOTA_EXCEEDED', message: 'The shared semantic daily or simultaneous-request allowance is exhausted. Exact source reads remain available as a separate operation.', details: { dailyCallLimit: daily, maxConcurrent: concurrent } });
  }
  return { id, day };
}

/** Only a validated completed response releases a slot early. Failures stay unknown. */
export async function completeSemantic(env: Env, reservation: SemanticReservation, usage: { inputTokens: number; outputTokens: number } | null, milliseconds = 250): Promise<boolean> {
  try {
    if (milliseconds <= 0) return false;
    const results = await boundedBatch(env, [
      env.METADATA.prepare(`UPDATE semantic_usage SET completed = completed + 1,
        unknown = unknown - 1, input_tokens = input_tokens + ?1, output_tokens = output_tokens + ?2
        WHERE day = ?3 AND EXISTS (SELECT 1 FROM semantic_reservations WHERE id = ?4)`).bind(usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, reservation.day, reservation.id),
      env.METADATA.prepare('DELETE FROM semantic_reservations WHERE id = ?1').bind(reservation.id)
    ], milliseconds);
    return results !== null && results.every((result) => result.success) && results[0]?.meta.changes === 1;
  } catch {
    // Admission was already charged. Keep unknown accounting and the expiring
    // reservation rather than refunding or obscuring valid semantic evidence.
    return false;
  }
}
