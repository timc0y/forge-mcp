import { describe, expect, it } from 'vitest';
import { createEvidence, evidenceHash, verifyEvidence } from '@forge/evidence';

const AT = '2026-07-16T00:00:00.000Z';

describe('evidence model', () => {
  it('hashes deterministically regardless of key order', () => {
    const a = evidenceHash({ id: 'e1', kind: 'test_result', state: 'passed', summary: { a: 1, b: 2 }, capturedAt: AT });
    const b = evidenceHash({ id: 'e1', kind: 'test_result', state: 'passed', summary: { b: 2, a: 1 }, capturedAt: AT });
    expect(a).toBe(b);
  });

  it('creates verifiable evidence and detects tampering', () => {
    const evidence = createEvidence({
      id: 'e1',
      kind: 'test_result',
      state: 'passed',
      summary: { passed: 12, failed: 0 },
      capturedAt: AT
    });
    expect(verifyEvidence(evidence)).toBe(true);
    const tampered = { ...evidence, state: 'failed' as const };
    expect(verifyEvidence(tampered)).toBe(false);
  });

  it('refuses to mark a screenshot as passed and records its limitation', () => {
    expect(() =>
      createEvidence({ id: 'e2', kind: 'screenshot', state: 'passed', summary: {}, capturedAt: AT })
    ).toThrow();
    const captured = createEvidence({ id: 'e2', kind: 'screenshot', state: 'captured', summary: {}, capturedAt: AT });
    expect(captured.limitations.join(' ')).toMatch(/interactions that were not executed/i);
  });

  it('preserves explicit non-success states', () => {
    for (const state of ['captured', 'failed', 'partial', 'blocked', 'unavailable'] as const) {
      const evidence = createEvidence({ id: `e-${state}`, kind: 'command_result', state, summary: {}, capturedAt: AT });
      expect(evidence.state).toBe(state);
    }
  });
});
