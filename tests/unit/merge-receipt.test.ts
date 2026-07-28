import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSION = readFileSync(join(process.cwd(), 'apps/forge-edge-gateway/src/mcp-session.ts'), 'utf8');

const CORE = readFileSync(join(process.cwd(), 'packages/mcp-core/src/index.ts'), 'utf8');

describe('forge_merge receipt', () => {
  it('does not let the schema forbid an honest answer', () => {
    // The output schema declared feature_branch_on_origin as z.literal(true),
    // so reporting the truthful `false` would have failed validation. A schema
    // that only permits the reassuring answer guarantees the reassuring answer.
    expect(CORE).not.toContain('feature_branch_on_origin: z.literal(true)');
    expect(CORE).toContain('feature_branch_on_origin: z.boolean()');
  });

  it('never hardcodes that the branch is on origin', () => {
    // It read `feature_branch_on_origin: true as const`, asserting remote
    // presence whether or not the branch was there — the same false assurance
    // that caused the original incident, in the tool that reports completion.
    expect(SESSION).not.toContain('feature_branch_on_origin: true as const');
    expect(SESSION).toContain('feature_branch_on_origin: Boolean(remoteHead)');
  });

  it('verifies the branch on origin before staging a second copy', () => {
    // Staging re-pushes through the Git credential proxy. Under remote-first
    // the commits are already on origin, so that duplicate push is pure risk:
    // in the wild it returned HTTP 403 and the whole merge was reported broken
    // while the work sat safely on the branch.
    const merge = SESSION.slice(SESSION.indexOf('forge_merge: async'));
    const verifyAt = merge.indexOf('git/ref/heads/');
    const stageAt = merge.indexOf('stageForReview');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(stageAt);
  });
});
