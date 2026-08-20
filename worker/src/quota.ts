/**
 * The two ledgers that keep an invite-only preview affordable: how many
 * captures a user has spent today, and which invite let them in. `main` is
 * GitHub's problem; these two D1 tables are the only state Forge itself owns
 * for capture. Nowhere else touches `capture_usage` or `invites`.
 */
import type { Env } from './env';
import { ForgeError } from './errors';

const DEFAULT_DAILY_LIMIT = 30;

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

export async function checkCaptureQuota(env: Env, userId: string): Promise<{ used: number; limit: number }> {
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
      details: { used, limit }
    });
  }

  return { used, limit };
}

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

export async function claimInvite(env: Env, code: string, userId: string): Promise<void> {
  // `claimed_by IS NULL` is the whole atomicity story: two simultaneous claims
  // of the same code race on this UPDATE, and only one of them can change a
  // row that still has a NULL claimant. `meta.changes` says which one did.
  const result = await env.METADATA.prepare(
    'UPDATE invites SET claimed_by = ?1, claimed_at = ?2 WHERE code = ?3 AND claimed_by IS NULL'
  )
    .bind(userId, new Date().toISOString(), code)
    .run();

  if ((result.meta.changes ?? 0) !== 1) {
    // Identical message whether the code never existed or was already spent —
    // distinguishing the two would let a caller enumerate valid codes.
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'That invite code is not valid.'
    });
  }
}
