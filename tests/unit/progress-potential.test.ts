import { describe, expect, it } from 'vitest';
import {
  PROGRESS_STREAK_LIMIT,
  PROGRESS_ENTROPY_WINDOW,
  classifyToolProgress,
  detectDurableWitness,
  durableFingerprint,
  emptyProgressStreak,
  observeProgressEvent,
  progressGate,
  shannonEntropyBits
} from '@forge/application';

describe('Durable Progress Potential (Φ-gate)', () => {
  it('classifies waits/reads as observational and shell/edit as progress-seeking', () => {
    expect(classifyToolProgress('forge_process_wait')).toBe('observational');
    expect(classifyToolProgress('forge_files_read')).toBe('observational');
    expect(classifyToolProgress('forge_shell')).toBe('progress_seeking');
    expect(classifyToolProgress('forge_edit')).toBe('progress_seeking');
  });

  it('keeps Φ fingerprint stable for identical durable parts', () => {
    const a = durableFingerprint({
      headSha: 'abc',
      depsStatus: 'ready',
      branch: 'forge/x',
      activeProcessIds: ['proc_b', 'proc_a']
    });
    const b = durableFingerprint({
      headSha: 'abc',
      depsStatus: 'ready',
      branch: 'forge/x',
      activeProcessIds: ['proc_a', 'proc_b']
    });
    expect(a).toBe(b);
    expect(
      durableFingerprint({ headSha: 'abd', depsStatus: 'ready', branch: 'forge/x' })
    ).not.toBe(a);
  });

  it('computes Shannon entropy in bits', () => {
    expect(shannonEntropyBits([])).toBe(0);
    expect(shannonEntropyBits(['a', 'a', 'a', 'a'])).toBe(0);
    expect(shannonEntropyBits(['a', 'b'])).toBeCloseTo(1, 5);
    expect(shannonEntropyBits(['a', 'b', 'c', 'd'])).toBeCloseTo(2, 5);
  });

  it('increments streak on progress-seeking success without witness, resets on forge_edit', () => {
    let state = emptyProgressStreak();
    for (let i = 0; i < 3; i += 1) {
      state = observeProgressEvent(state, {
        tool: 'forge_shell',
        durableWitness: false,
        argsHash: `h${i}`,
        status: 'success'
      });
    }
    expect(state.streak).toBe(3);

    state = observeProgressEvent(state, {
      tool: 'forge_process_wait',
      durableWitness: false,
      status: 'success'
    });
    expect(state.streak).toBe(3);

    state = observeProgressEvent(state, {
      tool: 'forge_edit',
      durableWitness: true,
      argsHash: 'edit',
      status: 'success'
    });
    expect(state.streak).toBe(0);
    expect(state.recent).toEqual([]);
  });

  it('refuses the next progress-seeking call after Φ streak hits the limit', () => {
    let state = emptyProgressStreak();
    for (let i = 0; i < PROGRESS_STREAK_LIMIT; i += 1) {
      state = observeProgressEvent(state, {
        tool: 'forge_shell',
        durableWitness: false,
        argsHash: 'same',
        status: 'success'
      });
      expect(progressGate(state, 'forge_shell').allow).toBe(i + 1 < PROGRESS_STREAK_LIMIT);
    }
    const gate = progressGate(state, 'forge_preview');
    expect(gate.allow).toBe(false);
    if (!gate.allow) {
      expect(gate.reason).toBe('zero_progress_streak');
      expect(gate.next_step).toMatch(/forge_edit/);
      expect(gate.allowedNextActions).toContain('forge_edit');
    }
    expect(progressGate(state, 'forge_files_read').allow).toBe(true);
  });

  it('warns one call before the hard refuse', () => {
    let state = emptyProgressStreak();
    for (let i = 0; i < PROGRESS_STREAK_LIMIT - 1; i += 1) {
      state = observeProgressEvent(state, {
        tool: 'forge_shell',
        durableWitness: false,
        argsHash: 'x',
        status: 'success'
      });
    }
    const gate = progressGate(state, 'forge_shell');
    expect(gate.allow).toBe(true);
    if (gate.allow) expect(gate.warning).toMatch(/Φ-warning/);
  });

  it('trips on high-entropy thrash near the limit', () => {
    const state = {
      phi: '',
      streak: PROGRESS_STREAK_LIMIT - 1,
      recent: Array.from({ length: PROGRESS_ENTROPY_WINDOW }, (_, i) => `forge_shell:unique-${i}`),
      updatedAt: new Date().toISOString()
    };
    expect(shannonEntropyBits(state.recent)).toBeGreaterThan(2.5);
    const gate = progressGate(state, 'forge_deps_install');
    expect(gate.allow).toBe(false);
    if (!gate.allow) expect(gate.reason).toBe('entropy_thrash');
  });

  it('detects durable witnesses from forge_edit / merge receipts', () => {
    expect(detectDurableWitness('forge_edit', { commit_url: 'https://github.com/o/r/commit/abc' })).toBe(true);
    expect(detectDurableWitness('forge_edit', { exitCode: 0, remote_persisted: false })).toBe(false);
    expect(detectDurableWitness('forge_merge', { submitted: true, submission_receipt: {} })).toBe(true);
    expect(detectDurableWitness('forge_shell', { exitCode: 0 })).toBe(false);
  });
});
