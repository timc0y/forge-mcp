import { describe, expect, it } from 'vitest';
import { ForgeError, toForgeError } from '@forge/core';
import { describeDurability, durabilityNextStep } from '../../apps/forge-edge-gateway/src/durability';

describe('ForgeError across an RPC boundary', () => {
  it('rebuilds a serialized ForgeError instead of flattening it', () => {
    // A ForgeError thrown inside a Durable Object arrives as a plain object:
    // every field intact, but `instanceof` false. It used to become
    // FORGE_INTERNAL_ERROR, destroying the code the agent keys recovery on.
    const overRpc = {
      name: 'ForgeError',
      code: 'FORGE_STALE_REVISION',
      message: 'Workspace revision moved on.',
      retryable: false,
      details: { expected: 4, actual: 7 }
    };

    const rebuilt = toForgeError(overRpc);

    expect(rebuilt).toBeInstanceOf(ForgeError);
    expect(rebuilt.code).toBe('FORGE_STALE_REVISION');
    expect(rebuilt.message).toBe('Workspace revision moved on.');
    expect(rebuilt.details).toMatchObject({ expected: 4, actual: 7 });
  });

  it('infers only the codes that change what an agent does next', () => {
    expect(toForgeError(new Error('patch does not apply')).code).toBe('FORGE_PATCH_REJECTED');
    expect(toForgeError(new Error('stale revision: re-read first')).code).toBe('FORGE_STALE_REVISION');
    const push = toForgeError(new Error('auto-push of forge/x failed after commit'));
    expect(push.code).toBe('FORGE_GIT_PUSH_BLOCKED');
    expect(push.retryable).toBe(true);
    expect(push.details).toMatchObject({ codeInferredFromMessage: true });
  });

  it('leaves a genuinely unknown failure generic', () => {
    const unknown = toForgeError(new Error('socket hang up'));
    expect(unknown.code).toBe('FORGE_INTERNAL_ERROR');
    expect(unknown.details).toMatchObject({ reason: 'socket hang up' });
  });

  it('never rewraps a real ForgeError', () => {
    const original = new ForgeError({ code: 'FORGE_FILE_CONFLICT', message: 'conflict', retryable: false });
    expect(toForgeError(original)).toBe(original);
  });
});

describe('mutationOutcome separates the edit from its persistence', () => {
  it('reports committed_local and tells the agent NOT to repeat the edit', () => {
    // The edit succeeded; only the push failed. Reporting that as a plain
    // failure is what made agents re-apply the edit and then hit a second,
    // unrelated-looking "nothing to commit" fault.
    const verdict = describeDurability({
      branch: 'forge/x',
      commit: 'a'.repeat(40),
      hasUnpushedWork: true,
      pushFailureReason: 'HTTP 403'
    });

    expect(verdict.mutationOutcome).toBe('committed_local');
    expect(verdict.durability).toBe('local_only');
    expect(durabilityNextStep(verdict)).toMatch(/do NOT repeat it/iu);
    expect(durabilityNextStep(verdict)).toMatch(/LOCAL ONLY/u);
  });

  it('reports pushed_remote only against a verified remote', () => {
    const verdict = describeDurability({
      branch: 'forge/x',
      commit: 'b'.repeat(40),
      hasUnpushedWork: false,
      pushVerified: true,
      remoteSha: 'b'.repeat(40)
    });
    expect(verdict.mutationOutcome).toBe('pushed_remote');
    expect(verdict.on_remote).toBe(true);
  });

  it('reports unchanged when the call found nothing to commit', () => {
    const verdict = describeDurability({
      branch: 'forge/x',
      commit: 'c'.repeat(40),
      hasUnpushedWork: false,
      committed: false,
      remoteSha: 'c'.repeat(40)
    });
    expect(verdict.mutationOutcome).toBe('unchanged');
    expect(verdict.durability_statement).toMatch(/Nothing to commit/iu);
  });
});
