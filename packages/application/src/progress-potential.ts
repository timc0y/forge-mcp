/**
 * Durable Progress Potential (Φ-gate) + causal witness chain
 *
 * Discrete Lyapunov / monotone-potential control for agent tool trajectories.
 * ChatGPT spirals are paths that keep calling progress-seeking tools while the
 * durable fingerprint Φ (GitHub head / deps / live processes) does not move.
 *
 *   Φ_t   = durable workspace fingerprint
 *   ΔΦ_t  = 1[Φ_t ≠ Φ_{t-1}]  ∨  durableWitness_t
 *   S_t   = 0 if ΔΦ_t else S_{t-1}+1  (only for progress-seeking successes
 *           after verify-budget is exhausted)
 *   trip  ⇔  S_t ≥ K before the next progress-seeking call
 *
 * Verify-budget: after a durable witness, allow B verify calls (tests/shell)
 * without incrementing S — a dwell-credit barrier so legitimate
 * edit→test→edit loops are not false positives.
 *
 * Causal certificate: each witness extends a hash chain tip. Receipts expose
 * tip + depth so “done” claims can be checked against an unbroken chain.
 *
 * Shannon entropy of the recent (tool, argsHash) window is a thrash signal:
 * high novelty with zero witnesses also trips (A↔B↔C loops).
 *
 * Unproven as a general agent-control law; classical nonlinear control
 * applied to MCP tool streams. Compose with identical-failure detection.
 */

import { durabilityNextStep } from './managed-processes.js';

/** Consecutive progress-seeking successes allowed without a durable witness. */
export const PROGRESS_STREAK_LIMIT = 4;

/** Sliding window for entropy thrash detection. */
export const PROGRESS_ENTROPY_WINDOW = 8;

/** Bits of Shannon entropy (base 2) over the window that count as thrashing. */
export const PROGRESS_ENTROPY_THRASH_BITS = 2.5;

/**
 * After a durable witness, this many progress-seeking successes may run
 * without incrementing the zero-progress streak (edit → test → preview).
 */
export const PROGRESS_VERIFY_BUDGET = 6;

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
  /** Remaining verify credits after the last witness. */
  verifyBudget: number;
  /** Causal witness-chain tip (hex); empty until first witness. */
  witnessTip: string;
  /** Number of durable witnesses in this session chain. */
  witnessDepth: number;
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
  /** Stable id for the causal chain (commit sha, task id, workspace id…). */
  witnessId?: string;
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

/** Extend the causal witness chain: tip' = H(tip ‖ tool ‖ id ‖ at). */
export function extendWitnessChain(
  prevTip: string,
  witness: { tool: string; id: string; at: string }
): string {
  return durableFingerprint({
    headSha: `${prevTip || 'genesis'}|${witness.tool}|${witness.id}|${witness.at}`,
    depsStatus: '',
    branch: '',
    activeProcessIds: []
  });
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
  return {
    phi: '',
    streak: 0,
    verifyBudget: 0,
    witnessTip: '',
    witnessDepth: 0,
    recent: [],
    updatedAt: now
  };
}

function unwrapStructured(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') return {};
  const record = result as Record<string, unknown>;
  if (record.structuredContent && typeof record.structuredContent === 'object') {
    return record.structuredContent as Record<string, unknown>;
  }
  return record;
}

/**
 * Best-effort Φ from a tool receipt (compact workspace get, edit, deps…).
 * Missing fields yield a partial fingerprint — still useful for ΔΦ.
 */
export function phiFromReceipt(result: unknown): string | undefined {
  const s = unwrapStructured(result);
  const deps =
    s.dependencyState && typeof s.dependencyState === 'object'
      ? (s.dependencyState as { status?: string }).status
      : undefined;
  const head =
    (typeof s.currentCommit === 'string' && s.currentCommit) ||
    (typeof s.remote_sha === 'string' && s.remote_sha) ||
    undefined;
  const branch =
    (typeof s.currentBranch === 'string' && s.currentBranch) ||
    (typeof s.branch === 'string' && s.branch) ||
    (typeof s.current_branch === 'string' && s.current_branch) ||
    undefined;
  const procs = Array.isArray(s.activeProcessIds)
    ? (s.activeProcessIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : undefined;
  if (!head && !deps && !branch && !procs?.length) return undefined;
  return durableFingerprint({
    headSha: head,
    depsStatus: deps,
    branch,
    activeProcessIds: procs
  });
}

/** Stable id for the causal chain when a witness fires. */
export function witnessIdFromReceipt(tool: string, result: unknown): string | undefined {
  const s = unwrapStructured(result);
  if (tool === 'forge_edit') {
    const id = s.remote_sha ?? s.commit_url;
    return typeof id === 'string' ? id : undefined;
  }
  if (tool === 'forge_merge') {
    if (typeof s.merge_sha === 'string' && s.merge_sha) return s.merge_sha;
    if (typeof s.head_sha === 'string' && typeof s.approval_url === 'string') return s.head_sha;
    const receipt = s.submission_receipt;
    if (receipt && typeof receipt === 'object') {
      const remote = (receipt as { remote_sha?: string; approval_id?: string }).remote_sha
        ?? (receipt as { approval_id?: string }).approval_id;
      if (typeof remote === 'string') return remote;
    }
    if (typeof s.approval_id === 'string') return s.approval_id;
  }
  if (tool === 'forge_task_create' && typeof s.task_id === 'string') return s.task_id;
  if (tool === 'forge_workspace_create' && typeof s.workspace_id === 'string') return s.workspace_id;
  if (tool === 'forge_start' && typeof s.branch === 'string') return s.branch;
  if (tool === 'forge_deps_install') {
    const deps = s.dependencyState;
    if (deps && typeof deps === 'object') {
      const hash = (deps as { lockfileHash?: string }).lockfileHash;
      if (typeof hash === 'string') return hash;
    }
  }
  if (tool === 'forge_deploy') {
    const receipt = s.deploy_receipt;
    if (receipt && typeof receipt === 'object') {
      const url = (receipt as { verified_url?: string }).verified_url;
      if (typeof url === 'string') return url;
    }
  }
  return undefined;
}

/**
 * Update streak after a tool call. Errors do not advance the zero-progress
 * streak (identical-failure detection owns that); successes without a witness
 * consume verify-budget first, then increment S.
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
    const id = event.witnessId ?? event.phiNow ?? event.tool;
    const tip = extendWitnessChain(state.witnessTip, { tool: event.tool, id, at: now });
    return {
      phi: event.phiNow ?? state.phi,
      streak: 0,
      verifyBudget: PROGRESS_VERIFY_BUDGET,
      witnessTip: tip,
      witnessDepth: state.witnessDepth + 1,
      recent: [],
      updatedAt: now
    };
  }

  if (event.status !== 'success' || kind === 'observational') {
    return {
      ...state,
      phi: event.phiNow ?? state.phi,
      recent,
      updatedAt: now
    };
  }

  // Dwell credit: verify loops after forge_edit do not count as spirals.
  if (state.verifyBudget > 0) {
    return {
      ...state,
      phi: event.phiNow ?? state.phi,
      verifyBudget: state.verifyBudget - 1,
      recent,
      updatedAt: now
    };
  }

  return {
    ...state,
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

  const s = state ?? emptyProgressStreak();

  // Verify-budget means the last witness bought legitimate follow-up work.
  if (s.verifyBudget > 0) return { allow: true };

  const limit = options.limit ?? PROGRESS_STREAK_LIMIT;
  const thrashBits = options.thrashBits ?? PROGRESS_ENTROPY_THRASH_BITS;
  const streak = s.streak;
  const entropy = shannonEntropyBits(s.recent);
  const thrash =
    s.recent.length >= PROGRESS_ENTROPY_WINDOW &&
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
        (s.witnessDepth
          ? ` (causal certificate depth ${s.witnessDepth}, tip ${s.witnessTip || '∅'})`
          : ' (no durable witness yet in this session)') +
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
  const structured = unwrapStructured(result);

  if (tool === 'forge_edit') {
    if (structured.commit_url || structured.remote_sha) return true;
    if (structured.on_remote === true) return true;
  }
  if (tool === 'forge_merge' && (
    structured.submitted === true ||
    structured.submission_receipt ||
    (typeof structured.approval_url === 'string' && structured.pull_request != null) ||
    (structured.merged === true && typeof structured.merge_sha === 'string' && structured.merge_sha.length > 0)
  )) return true;
  if (tool === 'forge_task_create' && typeof structured.task_id === 'string') return true;
  if (tool === 'forge_task_update' && structured.revision != null) return true;
  if (tool === 'forge_deps_install') {
    const deps = structured.dependencyState;
    if (deps && typeof deps === 'object' && (deps as { usable?: boolean }).usable === true) return true;
    if (structured.success === true && structured.status === 'ready') return true;
  }
  if (tool === 'forge_start' && typeof structured.branch === 'string') return true;
  if (tool === 'forge_workspace_create' && typeof structured.workspace_id === 'string') return true;
  if (tool === 'forge_deploy') {
    const receipt = structured.deploy_receipt;
    if (receipt && typeof receipt === 'object' && (receipt as { verified_url?: string }).verified_url) {
      return true;
    }
  }
  return false;
}

/** Compact receipt field agents can read without a second system. */
export function progressPotentialView(state: ProgressStreakState | null): {
  streak: number;
  limit: number;
  verify_budget: number;
  entropy_bits: number;
  phi: string;
  witness_tip: string;
  witness_depth: number;
} {
  const s = state ?? emptyProgressStreak();
  return {
    streak: s.streak,
    limit: PROGRESS_STREAK_LIMIT,
    verify_budget: s.verifyBudget,
    entropy_bits: Number(shannonEntropyBits(s.recent).toFixed(3)),
    phi: s.phi,
    witness_tip: s.witnessTip,
    witness_depth: s.witnessDepth
  };
}
