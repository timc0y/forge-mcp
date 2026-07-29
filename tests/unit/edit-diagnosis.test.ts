import { describe, expect, it } from 'vitest';
import { toForgeError } from '@forge/core';

/**
 * Both of these come from the production tool-call log, not from imagination.
 * forge_edit failed 12 of 17 calls on 28 July, and two of the failure modes
 * were the tool stating a cause it had not established.
 */
describe('forge_edit reports the cause it actually has', () => {
  it('keeps the real reason instead of replacing it with a generic sentence', () => {
    // Three forge_edit calls failed with nothing but "Forge could not complete
    // the operation." The code captured the underlying message into
    // details.reason and then discarded it from the message the agent reads.
    const error = toForgeError(new Error('R2 multipart upload aborted after 3 attempts'));

    expect(error.code).toBe('FORGE_INTERNAL_ERROR');
    expect(error.message).toContain('R2 multipart upload aborted');
    // Still says what to do, rather than inviting a blind retry loop.
    expect(error.message).toMatch(/retry once/iu);
    expect(error.message).toMatch(/report it/iu);
    expect((error.details as { reason?: string })?.reason).toContain('R2 multipart');
  });

  it('does not invent a reason when the failure carried none', () => {
    const error = toForgeError({});
    expect(error.message).toMatch(/carried no detail/iu);
    expect(error.message).not.toMatch(/undefined|\[object/iu);
  });
});
