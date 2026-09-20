import { describe, expect, it } from 'vitest';
import type { GitHubRequest } from '../src/contracts';
import { failedChecks, readChecks, requiredChecksSatisfied } from '../src/checks';
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
  });
  it('never treats skipped, neutral, cancelled or pending as success', async () => {
    for (const state of ['skipped', 'neutral', 'cancelled', null]) {
      const gh: GitHubRequest = async (path) => reply(path.includes('check-runs') ? { check_runs: [check(state)] } : { sha, statuses: [] });
      expect(requiredChecksSatisfied(await readChecks(gh, { owner: 'o', name: 'r' }, sha), ['verify'])).toBe(false);
    }
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
