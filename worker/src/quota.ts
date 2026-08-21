import type { Env } from './env';
import { ForgeError } from './errors';

/**
 * The only meter in the product.
 *
 * GitHub work costs Forge nothing: every user installs the App themselves, so
 * reads, commits and merges are metered against their own installation limit.
 * Capture is the one action that spends Forge's money, so it is the one action
 * with a number attached.
 *
 * The preview is open to anyone. This limit is what makes that affordable — a
 * ceiling per person per day, rather than a gate that refuses everyone who
 * does not already know somebody.
 */

const DEFAULT_DAILY_LIMIT = 30;

function unlimited(env: Env, login: string): boolean {
  return (env.FORGE_UNLIMITED_LOGINS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(login.toLowerCase());
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dailyLimit(env: Env): number {
  const raw = env.FORGE_CAPTURE_DAILY_LIMIT;
  if (!raw) return DEFAULT_DAILY_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT;
}

function resetsAt(now: Date): string {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return `${utcDay(tomorrow)} 00:00 UTC`;
}

/**
 * Atomically reserve one capture before browser time is spent.
 *
 * The conditional upsert is the lock: concurrent calls cannot all read the same
 * remaining slot and then overspend it. D1 serializes the mutation, and only a
 * row whose count is still below the limit may be incremented.
 */
export async function reserveCaptureQuota(
  env: Env,
  userId: string,
  login: string
): Promise<{ used: number; limit: number; unlimited: boolean; day: string | null }> {
  if (unlimited(env, login)) return { used: 0, limit: 0, unlimited: true, day: null };

  const now = new Date();
  const day = utcDay(now);
  const limit = dailyLimit(env);
  const reserved = await env.METADATA.prepare(
    `INSERT INTO capture_usage (user_id, day, count) VALUES (?1, ?2, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1
       WHERE capture_usage.count < ?3`
  )
    .bind(userId, day, limit)
    .run();

  if ((reserved.meta.changes ?? 0) !== 1) {
    const row = await env.METADATA.prepare('SELECT count FROM capture_usage WHERE user_id = ?1 AND day = ?2')
      .bind(userId, day)
      .first<{ count: number }>();
    const used = row?.count ?? limit;
    throw new ForgeError({
      code: 'FORGE_QUOTA_EXCEEDED',
      message: `Daily capture limit of ${limit} reached. It resets at ${resetsAt(now)}.`,
      details: { used, limit, resets: resetsAt(now) }
    });
  }

  const row = await env.METADATA.prepare('SELECT count FROM capture_usage WHERE user_id = ?1 AND day = ?2')
    .bind(userId, day)
    .first<{ count: number }>();
  return { used: row?.count ?? 1, limit, unlimited: false, day };
}

/**
 * Give a reserved slot back only when no viewport succeeded. The reservation's
 * original UTC day is supplied so a failure that crosses midnight cannot
 * decrement the wrong day's counter.
 */
export async function releaseCaptureQuota(env: Env, userId: string, day: string): Promise<void> {
  await env.METADATA.prepare(
    `UPDATE capture_usage
        SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END
      WHERE user_id = ?1 AND day = ?2`
  )
    .bind(userId, day)
    .run();
}
