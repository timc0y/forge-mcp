import { describe, expect, it } from 'vitest';
import { ForgeApplicationService } from '@forge/application';
import type { ExecResult, SandboxHandle, SandboxProvider } from '@forge/sandbox-core';
import {
  DURABILITY_STATES,
  MUTATION_OUTCOMES,
  describeDurability,
  durabilityNextStep
} from '../../apps/forge-edge-gateway/src/durability';
import { assertReceivePackScope } from '../../packages/git-core/src/index';

describe('describeDurability', () => {
  it('refuses to call an unpushed commit "on the branch"', () => {
    const verdict = describeDurability({
      branch: 'forge/25b5950a6fd54c95',
      commit: '2ce892595853a245ab0810af77dad6ee0f72a7d0',
      hasUnpushedWork: true,
      pushFailureReason: 'remote rejected'
    });

    expect(verdict.durability).toBe('local_only');
    expect(verdict.on_remote).toBe(false);
    // The exact failure from the incident: a real branch name and a real SHA
    // summarised as durable storage. The statement must say the opposite.
    expect(verdict.durability_statement).toContain('NOT on GitHub');
    expect(verdict.durability_statement).toContain('will be lost');
    expect(verdict.remote_sha).toBeUndefined();
    expect(verdict.remote_branch).toBeUndefined();
    expect(durabilityNextStep(verdict)).toContain('LOCAL ONLY');
  });

  it('claims remote durability only once a push is verified', () => {
    const verdict = describeDurability({
      branch: 'forge/abc',
      commit: 'a'.repeat(40),
      hasUnpushedWork: false,
      pushVerified: true,
      remoteSha: 'a'.repeat(40)
    });

    expect(verdict.durability).toBe('remote_branch');
    expect(verdict.on_remote).toBe(true);
    expect(verdict.remote_branch).toBe('forge/abc');
    expect(verdict.durability_statement).toContain('survives the workspace');
  });

  it('reports a pull request only when the commit is also on origin', () => {
    const open = describeDurability({
      branch: 'forge/abc',
      commit: 'b'.repeat(40),
      hasUnpushedWork: false,
      pushVerified: true,
      pullRequestUrl: 'https://github.com/o/r/pull/1'
    });
    expect(open.durability).toBe('pull_request');

    // A PR URL cannot upgrade work that never reached origin.
    const unpushed = describeDurability({
      branch: 'forge/abc',
      commit: 'b'.repeat(40),
      hasUnpushedWork: true,
      pullRequestUrl: 'https://github.com/o/r/pull/1'
    });
    expect(unpushed.durability).toBe('local_only');
  });
});

function serviceReturning(result: Partial<ExecResult>): ForgeApplicationService {
  const handle = {
    exec: async (): Promise<ExecResult> => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 1,
      artifactRefs: [],
      ...result
    })
  } as unknown as SandboxHandle;
  return new ForgeApplicationService({
    kind: 'cloudflare',
    version: 'test',
    get: async () => handle
  } as unknown as SandboxProvider);
}

function forgeBranchRecord(service: ForgeApplicationService) {
  const record = service.initializeWorkspace({
    tenantId: 'ten_00000000000000000000000000' as never,
    projectId: 'prj_00000000000000000000000000' as never,
    repository: { provider: 'github', owner: 'acme', name: 'app' },
    ref: 'main',
    runtimeProfile: 'node-22',
    persistence: 'ephemeral',
    bootstrap: false,
    idempotencyKey: 'seed-idempotency-key',
    actor: { type: 'agent', id: 'agent' }
  });
  record.workspace.state = 'ready';
  record.workspace.currentBranch = 'forge/tim/fix';
  record.workspace.currentCommit = 'c'.repeat(40);
  return record;
}

describe('gitCommit with nothing staged', () => {
  it('reports a no-op instead of a hard FORGE_GIT_DIRTY failure', async () => {
    // An agent retrying a write after a push error re-runs the same edit, so
    // there is genuinely nothing new to commit. Treating that as a commit
    // failure invented a second, misleading fault and buried the real one —
    // the earlier commit still sitting unpushed.
    const service = serviceReturning({ exitCode: 1, stdout: 'nothing to commit, working tree clean\n' });
    const record = forgeBranchRecord(service);

    const result = await service.gitCommit(record, {
      message: 'retry the same edit',
      paths: ['docs/a.md'],
      idempotencyKey: 'retry-key'
    });

    expect(result).toMatchObject({ committed: false, reason: 'nothing to commit' });
    expect(result.commit).toBe('c'.repeat(40));
  });

  it('still fails loudly when the commit breaks for any other reason', async () => {
    const service = serviceReturning({ exitCode: 1, stderr: 'fatal: cannot lock ref\n' });
    const record = forgeBranchRecord(service);

    await expect(
      service.gitCommit(record, { message: 'real failure', paths: [], idempotencyKey: 'k' })
    ).rejects.toMatchObject({ code: 'FORGE_GIT_DIRTY' });
  });

  it('marks a real commit as committed and unpushed', async () => {
    const head = 'd'.repeat(40);
    const service = serviceReturning({ exitCode: 0, stdout: `[forge/tim/fix abc] msg\n${head}\nforge/tim/fix\n` });
    const record = forgeBranchRecord(service);

    const result = await service.gitCommit(record, { message: 'real work', paths: [], idempotencyKey: 'k2' });

    expect(result).toMatchObject({ committed: true, commit: head });
    // Unpushed until a push is verified — this flag is what drives the retry.
    expect(record.workspace.hasUnpushedWork).toBe(true);
  });
});

describe('receive-pack scope diagnostics', () => {
  const ref = 'refs/heads/forge/x';
  const commit = 'e'.repeat(40);
  const ok = { oldCommit: '0'.repeat(40), newCommit: commit, ref };

  it('accepts a push that matches the capability', () => {
    expect(() => assertReceivePackScope([ok], 'forge/x', commit)).not.toThrow();
  });

  it('distinguishes an incomplete body from a scope violation', () => {
    // Both used to surface as the same opaque 403, and they need different fixes.
    expect(() => assertReceivePackScope(null, 'forge/x', commit)).toThrow(/incomplete/iu);
    expect(() => assertReceivePackScope([], 'forge/x', commit)).toThrow(/no ref updates/iu);
  });

  it('names the offending ref when the branch is wrong', () => {
    const wrongRef = { ...ok, ref: 'refs/heads/main' };
    expect(() => assertReceivePackScope([wrongRef], 'forge/x', commit))
      .toThrow(/refs\/heads\/main.*only authorises refs\/heads\/forge\/x/u);
  });

  it('names both commits when the commit is wrong', () => {
    const wrongCommit = { ...ok, newCommit: 'f'.repeat(40) };
    expect(() => assertReceivePackScope([wrongCommit], 'forge/x', commit))
      .toThrow(/f{40}.*only authorises commit e{40}/u);
  });
});

describe('advertised vocabularies', () => {
  it('lists exactly the states describeDurability can return', () => {
    // forge_capabilities used to restate these as a hand-written literal and
    // drifted: it told agents branch_push was approval_required and
    // direct_merge disabled, long after forge_edit committed straight to
    // GitHub and forge_pr could merge. An agent orienting itself there was
    // sent looking for a stage that no longer existed. Reading them from here
    // is what stops that happening again.
    expect([...DURABILITY_STATES].sort()).toEqual(
      ['failed_recovered', 'local_only', 'pull_request', 'remote_branch']
    );
    expect([...MUTATION_OUTCOMES].sort()).toEqual(
      ['committed_local', 'pushed_remote', 'unchanged', 'unknown', 'workspace_changed']
    );

    // Every state the builder can actually produce must be advertised.
    const produced = new Set([
      describeDurability({ branch: 'forge/a', commit: 'a'.repeat(40), hasUnpushedWork: true }).durability,
      describeDurability({ branch: 'forge/a', commit: 'a'.repeat(40), hasUnpushedWork: false, pushVerified: true }).durability,
      describeDurability({
        branch: 'forge/a',
        commit: 'a'.repeat(40),
        hasUnpushedWork: false,
        pushVerified: true,
        pullRequestUrl: 'https://github.com/o/r/pull/1'
      }).durability
    ]);
    for (const state of produced) expect(DURABILITY_STATES).toContain(state);
  });
});
