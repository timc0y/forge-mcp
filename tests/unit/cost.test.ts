import { describe, expect, it } from 'vitest';
import {
  budgetPosition,
  costMetadata,
  emptyUsage,
  estimateMonthlyUsd,
  gateComputeAction,
  type UsageCounters
} from '@forge/cost';

function usage(overrides: Partial<UsageCounters>): UsageCounters {
  return { ...emptyUsage(), ...overrides };
}

describe('cost estimation', () => {
  it('estimates from metered usage and is zero at rest', () => {
    expect(estimateMonthlyUsd(emptyUsage())).toBe(0);
    const busy = estimateMonthlyUsd(usage({ workspaceActiveMs: 3_600_000, browserCaptures: 10 }));
    expect(busy).toBeGreaterThan(0);
  });

  it('escalates budget level across thresholds', () => {
    // 200 workspace-hours at $0.05/hr = $10 → hard.
    const heavy = budgetPosition(usage({ workspaceActiveMs: 200 * 3_600_000 }));
    expect(heavy.level).toBe('hard');
    expect(budgetPosition(emptyUsage()).level).toBe('ok');
  });
});

describe('compute gating at the hard threshold', () => {
  const hard = budgetPosition(usage({ workspaceActiveMs: 250 * 3_600_000 }));

  it('refuses new cloud workspaces but allows cleanup and compute-free actions', () => {
    expect(gateComputeAction(hard, { createsCloudCompute: true }).allowed).toBe(false);
    expect(gateComputeAction(hard, { createsCloudCompute: true, isCleanup: true }).allowed).toBe(true);
    expect(gateComputeAction(hard, { createsCloudCompute: false }).allowed).toBe(true);
  });

  it('allows new workspaces below the hard threshold', () => {
    const ok = budgetPosition(emptyUsage());
    expect(gateComputeAction(ok, { createsCloudCompute: true }).allowed).toBe(true);
  });
});

describe('cost metadata', () => {
  it('produces compact metadata for tool responses', () => {
    const meta = costMetadata({
      backend: 'cloudflare-sandbox',
      containerUsed: true,
      browserUsed: false,
      costClass: 'moderate',
      workspaceAgeMs: 5000,
      position: budgetPosition(usage({ workspaceActiveMs: 3_600_000 }))
    });
    expect(meta.backend).toBe('cloudflare-sandbox');
    expect(meta.budget.level).toBe('ok');
    expect(meta.workspaceAgeMs).toBe(5000);
  });
});
