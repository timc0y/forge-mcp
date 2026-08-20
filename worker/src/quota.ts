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

/**
 * Logins the daily limit does not apply to. Comma separated, compared without
 * case, because a GitHub login is not case sensitive and a limit that depends
 * on capitalisation is a bug waiting for a bad day.
 *
 * This is the operator's own escape hatch, set in config. There is no path from
 * inside the product that grants it, and no tier it belongs to.
 */
function unlimited(env: Env, login: string): boolean {
  return (env.FORGE_UNLIMITED_LOGINS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(login.toLowerCase());
}

/** UTC calendar day as `YYYY-MM-DD`. A user's local day is not the meter's day. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dailyLimit(env: Env): number {
  const raw = env.FORGE_CAPTURE_DAILY_LIMIT;
  if (!raw) return DEFAULT_DAILY_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  // A misconfigured limit fails open to the default, not to zero — zero would
  // lock out every user until someone noticed the env var was wrong.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT;
}

/** Midnight UTC tomorrow, spelled out for a human reading a refusal. */
function resetsAt(now: Date): string {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return `${utcDay(tomorrow)} 00:00 UTC`;
}

/**
 * Refuses before any browser time is spent, and says when the limit lifts. A
 * quota that refuses without naming its own reset is a dead end.
 */
export async function checkCaptureQuota(
  env: Env,
  userId: string,
  login: string
): Promise<{ used: number; limit: number; unlimited: boolean }> {
  if (unlimited(env, login)) return { used: 0, limit: 0, unlimited: true };

  const now = new Date();
  const limit = dailyLimit(env);
  const row = await env.METADATA.prepare('SELECT count FROM capture_usage WHERE user_id = ?1 AND day = ?2')
    .bind(userId, utcDay(now))
    .first<{ count: number }>();
  const used = row?.count ?? 0;

  if (used >= limit) {
    throw new ForgeError({
      code: 'FORGE_QUOTA_EXCEEDED',
      message: `Daily capture limit of ${limit} reached. It resets at ${resetsAt(now)}.`,
      details: { used, limit, resets: resetsAt(now) }
    });
  }

  return { used, limit, unlimited: false };
}

/**
 * Counted after the capture succeeds, so a failed one never spends someone's
 * day.
 */
export async function recordCapture(env: Env, userId: string): Promise<void> {
  // Insert-or-increment in one statement: a read-then-write here is how two
  // captures that land in the same instant both read 0 and both write 1.
  await env.METADATA.prepare(
    `INSERT INTO capture_usage (user_id, day, count) VALUES (?1, ?2, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1`
  )
    .bind(userId, utcDay(new Date()))
    .run();
}
