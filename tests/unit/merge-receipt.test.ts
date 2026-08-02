import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from '@forge/core';
import {
  assertCleanForMerge,
  verifyFeatureBranchOnOrigin,
  type MinimalGitHubRequest
} from '../../apps/forge-edge-gateway/src/merge-guards';

const SESSION = readFileSync(join(process.cwd(), 'apps/forge-edge-gateway/src/handlers/repository-workspace.ts'), 'utf8');

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

  it('forge_merge never pushes: no push primitive is reachable from its handler', () => {
    // stageForReview (stage, then force-push the feature branch) is the exact
    // fallback that 403'd in the wild: an agent's commit was already on
    // origin, forge_merge pushed it again over the one transport that can
    // fail, and the whole merge was reported broken while the work sat safely
    // on the branch the whole time. It — and every other push primitive — must
    // not be reachable from forge_merge's own handler body ever again.
    const start = SESSION.indexOf('forge_merge: async');
    expect(start).toBeGreaterThan(-1);
    const end = SESSION.indexOf('forge_workspace_destroy: async', start);
    expect(end).toBeGreaterThan(start);
    const merge = SESSION.slice(start, end);
    expect(merge).not.toContain('stageForReview');
    expect(merge).not.toContain('autoPushForgeBranch');
    expect(merge).not.toContain('.gitPush(');
    expect(merge).not.toContain('gitCommit(');
    // It still verifies the branch is on origin — just never by pushing.
    expect(merge).toContain('verifyFeatureBranchOnOrigin');
    expect(merge).toContain('/compare/');
    expect(merge).not.toContain('gitStatus');
    expect(merge).not.toContain('gitOutgoingDiff');
    // Expired linked approvals must be reminted on replay, not echoed forever.
    expect(merge).toContain('rebindDeferredApproval');
    expect(merge).toContain('approvalStillUsable');
  });
});

describe('verifyFeatureBranchOnOrigin', () => {
  // The real end-to-end behaviour forge_merge depends on: read the branch's
  // head off GitHub, never push to make one appear.
  it('reports the branch on origin from a real ref read', async () => {
    const calls: string[] = [];
    const request: MinimalGitHubRequest = async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/repos/acme/app/git/ref/heads/forge/fix') {
        return { status: 200, json: { object: { sha: 'deadbeef' } } };
      }
      return { status: 404, json: {} };
    };

    const sha = await verifyFeatureBranchOnOrigin(request, { owner: 'acme', name: 'app' }, 'forge/fix');

    expect(sha).toBe('deadbeef');
    // The only call this made was a read — no push primitive is reachable.
    expect(calls).toEqual(['GET /repos/acme/app/git/ref/heads/forge/fix']);
  });

  it('refuses rather than pushing when the branch is not on origin', async () => {
    const request: MinimalGitHubRequest = async () => ({ status: 404, json: {} });

    await expect(
      verifyFeatureBranchOnOrigin(request, { owner: 'acme', name: 'app' }, 'forge/fix')
    ).rejects.toMatchObject({ code: 'FORGE_GIT_PUSH_BLOCKED' });
  });

  it('refuses when the read itself fails rather than assuming presence', async () => {
    const request: MinimalGitHubRequest = async () => {
      throw new Error('network error');
    };

    await expect(
      verifyFeatureBranchOnOrigin(request, { owner: 'acme', name: 'app' }, 'forge/fix')
    ).rejects.toMatchObject({ code: 'FORGE_GIT_PUSH_BLOCKED' });
  });
});

describe('assertCleanForMerge', () => {
  it('produces a clear refusal naming the dirty files', () => {
    try {
      assertCleanForMerge({ clean: false, changedPaths: ['src/a.ts', 'src/b.ts'] });
      throw new Error('expected assertCleanForMerge to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ForgeError);
      expect((error as ForgeError).code).toBe('FORGE_GIT_DIRTY');
      expect((error as ForgeError).message).toContain('src/a.ts, src/b.ts');
      // Tells the agent exactly what to do next, not just what went wrong.
      expect((error as ForgeError).message).toContain('forge_edit');
    }
  });

  it('passes a clean tree through without throwing', () => {
    expect(() => assertCleanForMerge({ clean: true })).not.toThrow();
  });

  it('passes through when the status read itself failed', () => {
    expect(() => assertCleanForMerge(undefined)).not.toThrow();
  });
});
