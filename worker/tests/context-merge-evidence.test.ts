import { describe, expect, it } from 'vitest';
import { requireMergeEvidence } from '../src/merge-evidence';

function report(overrides: Record<string, unknown> = {}) {
  return {
    blockers: [],
    checks: { coverage: 'complete', checks: [{ kind: 'check-run', status: 'completed', conclusion: 'success' }] },
    policy: { unavailable: undefined, truncated: false },
    reviews: { unavailable: undefined, truncated: false, mergeable: true },
    ...overrides
  } as any;
}

describe('merge evidence gate', () => {
  it('requires complete successful exact-head execution even without required branch checks', () => {
    expect(() => requireMergeEvidence(report({ checks: { coverage: 'unavailable', checks: [] } }))).toThrow(/exact-head check evidence/);
    expect(() => requireMergeEvidence(report({ checks: { coverage: 'bounded', checks: [] } }))).toThrow(/exact-head check evidence/);
    expect(() => requireMergeEvidence(report({ checks: { coverage: 'complete', checks: [] } }))).toThrow(/all-success execution evidence/);
    expect(() => requireMergeEvidence(report({ checks: { coverage: 'complete', checks: [{ kind: 'check-run', status: 'completed', conclusion: 'neutral' }] } }))).toThrow(/all-success execution evidence/);
  });

  it('refuses known blockers and unavailable policy', () => {
    expect(() => requireMergeEvidence(report({ blockers: ['Check verify: failure'] }))).toThrow(/known blockers/);
    expect(() => requireMergeEvidence(report({ policy: { unavailable: '403', truncated: false } }))).toThrow(/policy could not be established/);
  });

  it('refuses missing, truncated or unresolved pull-request state', () => {
    expect(() => requireMergeEvidence(report({ reviews: null }))).toThrow(/review or mergeability/);
    expect(() => requireMergeEvidence(report({ reviews: { unavailable: undefined, truncated: true, mergeable: true } }))).toThrow(/review or mergeability/);
    expect(() => requireMergeEvidence(report({ reviews: { unavailable: undefined, truncated: false, mergeable: null } }))).toThrow(/review or mergeability/);
  });

  it('permits approval preparation only when required evidence is complete and blocker-free', () => {
    expect(() => requireMergeEvidence(report())).not.toThrow();
  });
});
