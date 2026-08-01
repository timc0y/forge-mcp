/**
 * Durable Progress Potential (Φ-gate)
 *
 * Discrete Lyapunov / monotone-potential control for agent tool trajectories.
 * ChatGPT spirals are paths that keep calling progress-seeking tools while the
 * durable fingerprint Φ (GitHub head / deps / live processes) does not move.
 *
 *   Φ_t   = durable workspace fingerprint
 *   ΔΦ_t  = 1[Φ_t ≠ Φ_{t-1}]  ∨  durableWitness_t
 *   S_t   = 0 if ΔΦ_t else S_{t-1}+1  (only for progress-seeking successes)
 *   trip  ⇔  S_t ≥ K before the next progress-seeking call
 *
 * This is unproven as a general agent-control law, but it is the standard
 * “no progress ⇒ stuck” certificate from nonlinear control, applied to MCP
 * tool streams. Compose with identical-failure detection; do not replace it.
 *
 * Shannon entropy of the recent (tool, argsHash) window is an optional
 * thrash signal: high novelty with zero witnesses also trips (A↔B↔C loops).
 */

import { durabilityNextStep } from './managed-processes.js';

/** Consecutive progress-seeking successes allowed without a durable witness. */
export const PROGRESS_STREAK_LIMIT = 4;

/** Sliding window for entropy thrash detection. */
export const PROGRESS_ENTROPY_WINDOW = 8;

/** Bits of Shannon entropy (base 2) over the window that count as thrashing. */
export const PROGRESS_ENTROPY_THRASH_BITS = 2.5;

export type ToolProgressClass = 'observational' | 'progress_seeking';

const OBSERVATIONAL = new Set([
  'forge_workspace_get',
  'forge_operation_get',
  'forge_files_read',
  'forge_files_list',
  'forge_diff_metadata',
  'forge_context_get',
  'forge_history',
  'forge_access',
  'forge_branches',
  'forge_process_wait',
  'forge_process_logs',
  'forge_process_list',
  'forge_artifact_get',
  'forge_observer_workspaces',
  'forge_observer_workspace',
  'forge_observer_activity',
  'forge_task_get',
  'forge_task_list',
  'forge_repository_list',
  'forge_secret_list',
  'forge_pr'
]);

export function classifyToolProgress(tool: string): ToolProgressClass {
  return OBSERVATIONAL.has(tool) ? 'observational' : 'progress_seeking';
}

export interface ProgressStreakState {
  /** Opaque durable fingerprint when known; empty string if unknown. */
  phi: string;
  /** Consecutive progress-seeking successes without durable witness. */
  streak: number;
  /** Recent intent keys for entropy thrash (tool:argsHash). */
  recent: string[];
  updatedAt: string;
}

export interface ProgressObservation {
  tool: string;
  /** True when the call produced durable GitHub/task/deps progress. */
  durableWitness: boolean;
  /** Optional workspace fingerprint after the call. */
  phiNow?: string;
  /** Intent hash for entropy (omit for observational). */
  argsHash?: string;
  status: 'success' | 'error';
}

export interface ProgressGateAllow {
  allow: true;
  /** Soft warning when one call from the limit. */
  warning?: string;
}

export interface ProgressGateRefuse {
  allow: false;
  next_step: string;
  allowedNextActions: string[];
  streak: number;
  reason: 'zero_progress_streak' | 'entropy_thrash';
}

export type ProgressGateDecision = ProgressGateAllow | ProgressGateRefuse;

/** FNV-1a 32-bit — stable, dependency-free fingerprint of durable parts. */
export function durableFingerprint(parts: {
  headSha?: string | null;
  depsStatus?: string | null;
  activeProcessIds?: readonly string[] | null;
  branch?: string | null;
}): string {
  const material = [
    parts.headSha ?? '',
    parts.depsStatus ?? '',
    parts.branch ?? '',
    ...(parts.activeProcessIds ?? []).slice().sort()
  ].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Shannon entropy H = -Σ p log2 p over the multiset (bits). */
export function shannonEntropyBits(items: readonly string[]): number {
  if (items.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  const n = items.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

export function emptyProgressStreak(now = new Date().toISOString()): ProgressStreakState {
  return { phi: '', streak: 0, recent: [], updatedAt: now };
}

/**
 * Update streak after a tool call. Errors do not advance the zero-progress
 * streak (identical-failure detection owns that); successes without a witness do.
 */
export function observeProgressEvent(
  prev: ProgressStreakState | null,
  event: ProgressObservation,
  now = new Date().toISOString()
): ProgressStreakState {
  const state = prev ?? emptyProgressStreak(now);
  const kind = classifyToolProgress(event.tool);
  const phiMoved = Boolean(event.phiNow && state.phi && event.phiNow !== state.phi);
  const witness = event.durableWitness || phiMoved;
  const recent = [...state.recent];
  if (kind === 'progress_seeking' && event.argsHash) {
    recent.push(`${event.tool}:${event.argsHash}`);
    while (recent.length > PROGRESS_ENTROPY_WINDOW) recent.shift();
  }

  if (witness) {
    return {
      phi: event.phiNow ?? state.phi,
      streak: 0,
      recent: [],
      updatedAt: now
    };
  }

  if (event.status !== 'success' || kind === 'observational') {
    return {
      phi: event.phiNow ?? state.phi,
      streak: state.streak,
      recent,
      updatedAt: now
    };
  }

  return {
    phi: event.phiNow ?? state.phi,
    streak: state.streak + 1,
    recent,
    updatedAt: now
  };
}

export function progressGate(
  state: ProgressStreakState | null,
  tool: string,
  options: { limit?: number; thrashBits?: number } = {}
): ProgressGateDecision {
  const kind = classifyToolProgress(tool);
  if (kind === 'observational') return { allow: true };

  const limit = options.limit ?? PROGRESS_STREAK_LIMIT;
  const thrashBits = options.thrashBits ?? PROGRESS_ENTROPY_THRASH_BITS;
  const streak = state?.streak ?? 0;
  const entropy = shannonEntropyBits(state?.recent ?? []);
  const thrash =
    (state?.recent.length ?? 0) >= PROGRESS_ENTROPY_WINDOW &&
    entropy >= thrashBits &&
    streak >= Math.max(2, limit - 1);

  if (streak >= limit || thrash) {
    return {
      allow: false,
      streak,
      reason: thrash && streak < limit ? 'entropy_thrash' : 'zero_progress_streak',
      allowedNextActions: ['forge_files_read', 'forge_edit', 'forge_diff_metadata', 'forge_workspace_get'],
      next_step:
        `Progress potential Φ has not moved for ${streak} progress-seeking calls` +
        (thrash ? ` (tool-stream entropy ${entropy.toFixed(2)} bits)` : '') +
        `. ${durabilityNextStep('mutating')} Do not repeat forge_shell/preview/merge until forge_edit returns commit_url.`
    };
  }

  if (streak === limit - 1) {
    return {
      allow: true,
      warning:
        `Φ-warning: ${streak}/${limit} progress-seeking calls without a durable witness. ` +
        durabilityNextStep('mutating')
    };
  }
  return { allow: true };
}

/**
 * Detect durable witnesses from tool receipts. Prefer explicit GitHub/task
 * artefacts over executor exit codes (exit 0 is not durable).
 */
export function detectDurableWitness(tool: string, result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  const structured =
    record.structuredContent && typeof record.structuredContent === 'object'
      ? (record.structuredContent as Record<string, unknown>)
      : record;

  if (tool === 'forge_edit') {
    if (structured.commit_url || structured.remoteSha || structured.remote_sha) return true;
    if (structured.on_remote === true) return true;
  }
  if (tool === 'forge_merge' && (structured.submitted === true || structured.submission_receipt)) return true;
  if (tool === 'forge_task_create' && typeof structured.task_id === 'string') return true;
  if (tool === 'forge_task_update' && structured.revision != null) return true;
  if (tool === 'forge_deps_install') {
    const deps = structured.dependencyState;
    if (deps && typeof deps === 'object' && (deps as { usable?: boolean }).usable === true) return true;
    if (structured.success === true && structured.status === 'ready') return true;
  }
  if (tool === 'forge_start' && typeof structured.branch === 'string') return true;
  if (tool === 'forge_workspace_create' && typeof structured.workspace_id === 'string') return true;
  return false;
}

/** Compact receipt field agents can read without a second system. */
export function progressPotentialView(state: ProgressStreakState | null): {
  streak: number;
  limit: number;
  entropy_bits: number;
  phi: string;
} {
  const s = state ?? emptyProgressStreak();
  return {
    streak: s.streak,
    limit: PROGRESS_STREAK_LIMIT,
    entropy_bits: Number(shannonEntropyBits(s.recent).toFixed(3)),
    phi: s.phi
  };
}
