import type { GitHubRequest, RepoRef } from './contracts';
import { formatRepo } from './contracts';
import { requireSha, type Coverage } from './evidence';
import { object } from './snapshot';

export interface CheckEvidence {
  kind: 'check-run' | 'commit-status';
  id: number;
  name: string;
  testedSha: string;
  status: string;
  conclusion: string | null;
  app: string | null;
  url: string | null;
  annotations: Array<{ path: string; line: number; level: string; message: string }>;
}
export interface ChecksReport {
  testedSha: string;
  observedAt: string;
  coverage: Coverage;
  checks: CheckEvidence[];
  limitations: string[];
}
const text = (value: unknown, limit = 500): string => typeof value === 'string' ? value.slice(0, limit) : '';
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Checks and commit statuses are complementary observations of the same exact SHA. */
export async function readChecks(gh: GitHubRequest, repo: RepoRef, sha: string): Promise<ChecksReport> {
  requireSha(sha);
  const report: ChecksReport = { testedSha: sha, observedAt: new Date().toISOString(), coverage: 'complete', checks: [], limitations: [] };
  const api = `/repos/${formatRepo(repo)}`;
  let annotationReads = 0;
  let stateIncomplete = false;
  for (const kind of ['check-run', 'commit-status'] as const) {
    const path = kind === 'check-run' ? `/commits/${sha}/check-runs?filter=latest&per_page=100` : `/commits/${sha}/status?per_page=100`;
    let response: Awaited<ReturnType<GitHubRequest>>;
    try { response = await gh(api + path); }
    catch { stateIncomplete = true; report.limitations.push(`${kind} evidence could not be read; execution state is unknown.`); continue; }
    if (response.status !== 200) {
      stateIncomplete = true;
      report.limitations.push(`${kind} evidence unavailable: GitHub HTTP ${response.status}; this capability requires ${kind === 'check-run' ? 'Checks' : 'Commit statuses'} read permission. No older revision was queried.`);
      continue;
    }
    const body = object(response.json);
    const rows = kind === 'check-run' ? body?.check_runs : body?.statuses;
    if (!Array.isArray(rows)) { stateIncomplete = true; report.limitations.push(`${kind} response was malformed.`); continue; }
    if (kind === 'commit-status' && body?.sha !== sha) { stateIncomplete = true; report.limitations.push('Combined status belongs to a different revision; it was rejected.'); continue; }
    const total = kind === 'check-run' ? body?.total_count : body?.total_count;
    if (/rel="next"/.test(response.headers.get('link') ?? '') || (numeric(total) && total > rows.length)) { stateIncomplete = true; report.limitations.push(`${kind} list is bounded to its first 100 results.`); }
    const statusNames = new Set<string>();
    for (const raw of rows) {
      const row = object(raw);
      if (!row || !numeric(row.id)) { stateIncomplete = true; report.limitations.push(`Malformed ${kind} record omitted.`); continue; }
      if (kind === 'check-run' && row.head_sha !== sha) { stateIncomplete = true; report.limitations.push('Check tested another revision; it was rejected.'); continue; }
      const name = text(kind === 'check-run' ? row.name : row.context, 160);
      const state = text(kind === 'check-run' ? row.status : row.state, 40);
      if (!name || !state) { stateIncomplete = true; report.limitations.push(`Incomplete ${kind} record omitted.`); continue; }
      // Combined statuses are newest first; repeated contexts must not resurrect an earlier result.
      if (kind === 'commit-status' && statusNames.has(name)) continue;
      statusNames.add(name);
      const entry: CheckEvidence = {
        kind, id: row.id, name, testedSha: sha, status: state,
        conclusion: kind === 'check-run' ? (typeof row.conclusion === 'string' ? text(row.conclusion, 40) : null) : state,
        app: kind === 'check-run' ? text(object(row.app)?.slug, 80) || null : text(object(row.creator)?.login, 80) || null,
        url: text(kind === 'check-run' ? row.details_url : row.target_url, 2048) || null,
        annotations: []
      };
      report.checks.push(entry);
      const count = object(row.output)?.annotations_count;
      if (kind !== 'check-run' || !numeric(count) || count === 0) continue;
      if (annotationReads++ >= 4) { report.limitations.push('Further check annotations omitted by the request budget.'); continue; }
      const annotations = await gh(`${api}/check-runs/${row.id}/annotations?per_page=20`);
      if (annotations.status !== 200 || !Array.isArray(annotations.json)) { report.limitations.push(`Annotations unavailable for check ${row.id}.`); continue; }
      for (const rawAnnotation of annotations.json) {
        const a = object(rawAnnotation);
        if (typeof a?.path === 'string' && numeric(a.start_line) && typeof a.message === 'string') entry.annotations.push({ path: text(a.path, 500), line: a.start_line, level: text(a.annotation_level, 30), message: text(a.message, 1500) });
        else report.limitations.push('Malformed annotation omitted.');
      }
      if (count > entry.annotations.length) report.limitations.push(`Annotations for check ${row.id} are partial.`);
    }
  }
  report.limitations = [...new Set(report.limitations)];
  if (stateIncomplete) report.coverage = report.checks.length ? 'bounded' : 'unavailable';
  if (!report.checks.length && !stateIncomplete) report.limitations.push('GitHub returned no checks or statuses for this revision. This does not mean tests passed.');
  return report;
}
export function failedChecks(report: ChecksReport): CheckEvidence[] {
  return report.checks.filter((check) => ['failure', 'error', 'timed_out', 'action_required', 'startup_failure', 'cancelled', 'stale'].includes(check.conclusion ?? ''));
}
export function requiredChecksSatisfied(report: ChecksReport, required: readonly string[]): boolean {
  if (report.coverage !== 'complete') return false;
  return required.every((name) => {
    const matches = report.checks.filter((check) => check.name === name);
    return matches.length > 0 && matches.every((check) => check.conclusion === 'success' && (check.kind === 'commit-status' || check.status === 'completed'));
  });
}
