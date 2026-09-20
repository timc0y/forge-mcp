import { describe, expect, it } from 'vitest';
import { requireMergeEvidence } from '../src/merge-evidence';

function report(overrides: Record<string, unknown> = {}) {
  return {
    blockers: [],
    checks: { coverage: 'complete' },
    policy: { unavailable: undefined, truncated: false },
    ...overrides
  } as any;
}

describe('merge evidence gate', () => {
  it('requires complete exact-head check evidence even without required branch checks', () => {
    expect(() => requireMergeEvidence(report({ checks: { coverage: 'unavailable' } }))).toThrow(/exact-head check evidence/);
    expect(() => requireMergeEvidence(report({ checks: { coverage: 'bounded' } }))).toThrow(/exact-head check evidence/);
  });

  it('refuses known blockers and unavailable policy', () => {
    expect(() => requireMergeEvidence(report({ blockers: ['Check verify: failure'] }))).toThrow(/known blockers/);
    expect(() => requireMergeEvidence(report({ policy: { unavailable: '403', truncated: false } }))).toThrow(/policy could not be established/);
  });

  it('permits approval preparation only when required evidence is complete and blocker-free', () => {
    expect(() => requireMergeEvidence(report())).not.toThrow();
  });
});
