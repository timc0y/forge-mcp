import { describe, expect, it } from 'vitest';
import type { GitHubRequest } from '../src/contracts';
import { allObservedChecksSuccessful, failedChecks, readChecks, requiredChecksSatisfied } from '../src/checks';
const sha = 'a'.repeat(40);
const reply = (json: unknown, status = 200) => ({ status, json, text: '', headers: new Headers() });
const check = (conclusion: string | null, tested = sha) => ({ id: 1, name: 'verify', head_sha: tested, status: conclusion ? 'completed' : 'in_progress', conclusion, output: { annotations_count: 0 }, app: { slug: 'github-actions' } });

describe('exact-revision execution evidence', () => {
  it('reads checks and statuses without inspecting another revision', async () => {
    const calls: string[] = [];
    const gh: GitHubRequest = async (path) => { calls.push(path); return reply(path.includes('check-runs') ? { total_count: 1, check_runs: [check('success')] } : { sha, total_count: 0, statuses: [] }); };
    const result = await readChecks(gh, { owner: 'owner', name: 'repo' }, sha);
    expect(calls).toHaveLength(2);
    expect(calls.every((path) => path.includes(sha))).toBe(true);
    expect(requiredChecksSatisfied(result, ['verify'])).toBe(true);
    expect(allObservedChecksSuccessful(result)).toBe(true);
  });
  it('never treats skipped, neutral, cancelled, pending or zero checks as merge-ready success', async () => {
    for (const state of ['skipped', 'neutral', 'cancelled', null]) {
      const gh: GitHubRequest = async (path) => reply(path.includes('check-runs') ? { check_runs: [check(state)] } : { sha, statuses: [] });
      const report = await readChecks(gh, { owner: 'o', name: 'r' }, sha);
      expect(requiredChecksSatisfied(report, ['verify'])).toBe(false);
      expect(allObservedChecksSuccessful(report)).toBe(false);
    }
    const none: GitHubRequest = async (path) => {
      if (path.includes('/actions/workflows')) return reply({ total_count: 1, workflows: [{ name: 'CI', path: '.github/workflows/ci.yml', state: 'disabled_manually' }] });
      return reply(path.includes('check-runs') ? { check_runs: [] } : { sha, statuses: [] });
    };
    const noneReport = await readChecks(none, { owner: 'o', name: 'r' }, sha);
    expect(allObservedChecksSuccessful(noneReport)).toBe(false);
    expect(noneReport.workflows).toEqual([{ name: 'CI', path: '.github/workflows/ci.yml', state: 'disabled_manually' }]);
    expect(noneReport.limitations.join(' ')).toContain('disabled_manually');
  });
  it('classifies cancelled and stale checks as failures rather than successful completion', async () => {
    for (const state of ['cancelled', 'stale']) {
      const gh: GitHubRequest = async (path) => reply(path.includes('check-runs') ? { check_runs: [check(state)] } : { sha, statuses: [] });
      expect(failedChecks(await readChecks(gh, { owner: 'o', name: 'r' }, sha)).map((entry) => entry.conclusion)).toContain(state);
    }
  });
  it('keeps complete check-state coverage when only annotations are truncated', async () => {
    const annotated = { ...check('success'), output: { annotations_count: 25 } };
    const gh: GitHubRequest = async (path) => {
      if (path.includes('/annotations')) return reply([{ path: 'src/a.ts', start_line: 1, annotation_level: 'failure', message: 'detail' }]);
      return reply(path.includes('check-runs') ? { total_count: 1, check_runs: [annotated] } : { sha, total_count: 0, statuses: [] });
    };
    const report = await readChecks(gh, { owner: 'o', name: 'r' }, sha);
    expect(report.coverage).toBe('complete');
    expect(report.limitations.join(' ')).toContain('Annotations for check');
    expect(requiredChecksSatisfied(report, ['verify'])).toBe(true);
  });
  it('rejects a check on another SHA including a synthetic merge', async () => {
    const gh: GitHubRequest = async (path) => reply(path.includes('check-runs') ? { check_runs: [check('success', 'b'.repeat(40))] } : { sha, statuses: [] });
    const report = await readChecks(gh, { owner: 'o', name: 'r' }, sha);
    expect(report.checks).toHaveLength(0);
    expect(report.limitations.join(' ')).toContain('another revision');
  });
  it('reports permissions as unavailable, never no failures', async () => {
    const gh: GitHubRequest = async () => reply({}, 403);
    const result = await readChecks(gh, { owner: 'o', name: 'r' }, sha);
    expect(result.coverage).toBe('unavailable');
    expect(result.limitations.join(' ')).toContain('read permission');
  });
});
