/**
 * Cost controls for a single heavy personal deployment. The product target is
 * below approximately USD 10 per month. Cloudflare does not expose per-request
 * billing, so figures are ESTIMATES derived from metered usage — never claimed
 * as precise dollars.
 */

export interface UsageCounters {
  workspaceActiveMs: number;
  workspaceIdleMs: number;
  browserSessionMs: number;
  browserCaptures: number;
  dependencyInstalls: number;
  builds: number;
  commands: number;
  storedArtifactBytes: number;
}

export function emptyUsage(): UsageCounters {
  return {
    workspaceActiveMs: 0,
    workspaceIdleMs: 0,
    browserSessionMs: 0,
    browserCaptures: 0,
    dependencyInstalls: 0,
    builds: 0,
    commands: 0,
    storedArtifactBytes: 0
  };
}

/** Coarse, tunable unit costs in USD. Estimates, not billing. */
export interface CostModel {
  workspaceActiveUsdPerHour: number;
  browserSessionUsdPerHour: number;
  browserCaptureUsd: number;
  storedArtifactUsdPerGbMonth: number;
}

export const DEFAULT_COST_MODEL: CostModel = {
  workspaceActiveUsdPerHour: 0.05,
  browserSessionUsdPerHour: 0.1,
  browserCaptureUsd: 0.0005,
  storedArtifactUsdPerGbMonth: 0.015
};

export interface Thresholds {
  warningUsd: number;
  strongWarningUsd: number;
  /** Hard cloud-compute ceiling: refuse unnecessary new workspaces above this. */
  hardUsd: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  warningUsd: 5,
  strongWarningUsd: 8,
  hardUsd: 10
};

export function estimateMonthlyUsd(usage: UsageCounters, model: CostModel = DEFAULT_COST_MODEL): number {
  const workspace = (usage.workspaceActiveMs / 3_600_000) * model.workspaceActiveUsdPerHour;
  const browser = (usage.browserSessionMs / 3_600_000) * model.browserSessionUsdPerHour;
  const captures = usage.browserCaptures * model.browserCaptureUsd;
  const storageGb = usage.storedArtifactBytes / 1_073_741_824;
  const storage = storageGb * model.storedArtifactUsdPerGbMonth;
  return Number((workspace + browser + captures + storage).toFixed(4));
}

export type BudgetLevel = 'ok' | 'warning' | 'strong-warning' | 'hard';

export function budgetLevel(estimatedUsd: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): BudgetLevel {
  if (estimatedUsd >= thresholds.hardUsd) return 'hard';
  if (estimatedUsd >= thresholds.strongWarningUsd) return 'strong-warning';
  if (estimatedUsd >= thresholds.warningUsd) return 'warning';
  return 'ok';
}

export interface BudgetPosition {
  estimatedMonthlyUsd: number;
  level: BudgetLevel;
  thresholds: Thresholds;
  /** Human-readable position, e.g. "estimated $6.10/mo (warning)". */
  note: string;
}

export function budgetPosition(
  usage: UsageCounters,
  model: CostModel = DEFAULT_COST_MODEL,
  thresholds: Thresholds = DEFAULT_THRESHOLDS
): BudgetPosition {
  const estimatedMonthlyUsd = estimateMonthlyUsd(usage, model);
  const level = budgetLevel(estimatedMonthlyUsd, thresholds);
  return {
    estimatedMonthlyUsd,
    level,
    thresholds,
    note: `estimated $${estimatedMonthlyUsd.toFixed(2)}/mo (${level})`
  };
}

export type CostClass = 'free' | 'cheap' | 'moderate' | 'expensive';

/**
 * Whether an action that requires new cloud compute may proceed. At the hard
 * threshold, new cloud workspaces are refused, but cleanup, repository metadata,
 * task summaries and compute-free Git operations always remain allowed.
 */
export interface GateDecision {
  allowed: boolean;
  reason: string;
  level: BudgetLevel;
}

export function gateComputeAction(
  position: BudgetPosition,
  action: { createsCloudCompute: boolean; isCleanup?: boolean }
): GateDecision {
  if (action.isCleanup || !action.createsCloudCompute) {
    return { allowed: true, reason: 'Action does not require new cloud compute.', level: position.level };
  }
  if (position.level === 'hard') {
    return {
      allowed: false,
      reason: `Hard cloud-compute threshold reached (${position.note}). Refusing new workspaces; cleanup and compute-free actions still allowed.`,
      level: position.level
    };
  }
  return { allowed: true, reason: position.note, level: position.level };
}

/** Compact metadata for attaching to tool responses. */
export interface CostMetadata {
  backend: string;
  containerUsed: boolean;
  browserUsed: boolean;
  costClass: CostClass;
  workspaceAgeMs?: number;
  budget: { estimatedMonthlyUsd: number; level: BudgetLevel };
}

export function costMetadata(input: {
  backend: string;
  containerUsed: boolean;
  browserUsed: boolean;
  costClass: CostClass;
  workspaceAgeMs?: number;
  position: BudgetPosition;
}): CostMetadata {
  return {
    backend: input.backend,
    containerUsed: input.containerUsed,
    browserUsed: input.browserUsed,
    costClass: input.costClass,
    ...(input.workspaceAgeMs !== undefined ? { workspaceAgeMs: input.workspaceAgeMs } : {}),
    budget: { estimatedMonthlyUsd: input.position.estimatedMonthlyUsd, level: input.position.level }
  };
}
