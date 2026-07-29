import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('a missing branch is not reported as a missing file', () => {
  it('never tells an agent to create a file whose absence it has not established', () => {
    // The live failure: package.json, src/routing/index.ts and
    // scripts/build-graph.mjs were each reported as "does not exist on
    // forge/... — send content to create it". All three plainly existed; the
    // branch was what was missing. Following that advice sends whole-file
    // content over a real file and discards it.
    const source = readFileSync(
      join(process.cwd(), 'apps/forge-edge-gateway/src/mcp-session.ts'),
      'utf8'
    );
    const start = source.indexOf('so there is nothing to replace in it');
    expect(start).toBeGreaterThan(-1);
    const region = source.slice(Math.max(0, start - 2_500), start + 500);

    // The create-it advice must sit behind a proven-absent branch check.
    expect(region).toContain('git/ref/heads/');
    expect(region).toMatch(/branch_absent/u);
    expect(region).toMatch(/the file is not missing, the branch is/u);
    // And a non-404 must not be reported as absence at all.
    expect(region).toMatch(/status === 429 \|\| fetched\.status >= 500/u);
  });
});
