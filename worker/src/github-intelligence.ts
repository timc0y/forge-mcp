/**
 * Read-only repository intelligence GitHub can answer directly.
 *
 * These calls deliberately use APIs backed by the repository's committed state
 * and existing Forge permissions. No checkout, runner, polling, or stored copy.
 */
import type { GitHubRequest, RepoRef } from './contracts';

export interface RepositoryLanguage {
  name: string;
  bytes: number;
}

export async function readRepositoryLanguages(
  request: GitHubRequest,
  repo: RepoRef
): Promise<{ languages: RepositoryLanguage[]; unavailable?: string }> {
  const response = await request(`/repos/${repo.owner}/${repo.name}/languages`);
  if (response.status !== 200) {
    return { languages: [], unavailable: `GitHub language statistics returned HTTP ${response.status}.` };
  }
  if (typeof response.json !== 'object' || response.json === null || Array.isArray(response.json)) {
    return { languages: [], unavailable: 'GitHub returned unreadable language statistics.' };
  }
  const languages = Object.entries(response.json as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((left, right) => right.bytes - left.bytes);
  return { languages };
}

export interface CommitHistoryEntry {
  sha: string;
  message: string;
  date: string | null;
  author: string | null;
  committer: string | null;
  verified: boolean | null;
  url: string | null;
}

export interface ChurnEntry {
  path: string;
  touches: number;
  additions: number;
  deletions: number;
}

export async function readRecentChurn(
  request: GitHubRequest,
  repo: RepoRef,
  branch: string,
  commitLimit = 8
): Promise<{ entries: ChurnEntry[]; commitsSampled: number; truncated: boolean; unavailable?: string }> {
  const history = await readRecentHistory(request, repo, branch, undefined, commitLimit);
  if (history.unavailable) {
    return { entries: [], commitsSampled: 0, truncated: false, unavailable: history.unavailable };
  }
  const details = await Promise.all(
    history.commits.map(async (commit) => {
      const response = await request(`/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(commit.sha)}?per_page=100`);
      if (response.status !== 200) {
        return {
          files: [] as Array<{ filename: string; additions: number; deletions: number }>,
          truncated: false,
          unavailable: `GitHub commit detail for ${commit.sha.slice(0, 7)} returned HTTP ${response.status}.`
        };
      }
      if (typeof response.json !== 'object' || response.json === null || Array.isArray(response.json)) {
        return {
          files: [] as Array<{ filename: string; additions: number; deletions: number }>,
          truncated: false,
          unavailable: `GitHub returned unreadable commit detail for ${commit.sha.slice(0, 7)}.`
        };
      }
      const body = response.json as Record<string, unknown>;
      if (!Array.isArray(body.files)) {
        return {
          files: [] as Array<{ filename: string; additions: number; deletions: number }>,
          truncated: false,
          unavailable: `GitHub commit detail for ${commit.sha.slice(0, 7)} did not include a readable file list.`
        };
      }
      const files = body.files.flatMap((value): Array<{ filename: string; additions: number; deletions: number }> => {
        if (typeof value !== 'object' || value === null) return [];
        const file = value as Record<string, unknown>;
        if (typeof file.filename !== 'string') return [];
        return [{
          filename: file.filename,
          additions: typeof file.additions === 'number' ? file.additions : 0,
          deletions: typeof file.deletions === 'number' ? file.deletions : 0
        }];
      });
      return {
        files,
        truncated: /rel="next"/.test(response.headers.get('Link') ?? '') || files.length >= 300
      };
    })
  );
  const aggregate = new Map<string, ChurnEntry>();
  for (const detail of details) {
    for (const file of detail.files) {
      const current = aggregate.get(file.filename) ?? {
        path: file.filename,
        touches: 0,
        additions: 0,
        deletions: 0
      };
      current.touches += 1;
      current.additions += file.additions;
      current.deletions += file.deletions;
      aggregate.set(file.filename, current);
    }
  }
  return {
    entries: [...aggregate.values()].sort(
      (left, right) =>
        right.touches - left.touches ||
        right.additions + right.deletions - (left.additions + left.deletions) ||
        left.path.localeCompare(right.path)
    ),
    commitsSampled: history.commits.length,
    truncated: history.truncated || details.some((detail) => detail.truncated),
    ...(details.some((detail) => detail.unavailable)
      ? {
          unavailable:
            `Recent churn is partial: ${details.filter((detail) => detail.unavailable).length} of ${details.length} commit-detail lookups were unavailable. ` +
            details.filter((detail) => detail.unavailable).map((detail) => detail.unavailable).join(' ')
        }
      : {})
  };
}

export async function readRecentHistory(
  request: GitHubRequest,
  repo: RepoRef,
  branch: string,
  path?: string,
  limit = 12
): Promise<{ commits: CommitHistoryEntry[]; truncated: boolean; unavailable?: string }> {
  const query = new URLSearchParams({ sha: branch, per_page: String(Math.max(1, Math.min(limit, 100))) });
  if (path) query.set('path', path);
  const response = await request(`/repos/${repo.owner}/${repo.name}/commits?${query.toString()}`);
  if (response.status !== 200) {
    return {
      commits: [],
      truncated: false,
      unavailable: `GitHub commit history returned HTTP ${response.status}.`
    };
  }
  if (!Array.isArray(response.json)) {
    return {
      commits: [],
      truncated: false,
      unavailable: 'GitHub returned unreadable commit history.'
    };
  }

  const commits = response.json.flatMap((value): CommitHistoryEntry[] => {
    if (typeof value !== 'object' || value === null) return [];
    const row = value as Record<string, unknown>;
    if (typeof row.sha !== 'string') return [];
    const commit = typeof row.commit === 'object' && row.commit !== null
      ? row.commit as Record<string, unknown>
      : {};
    const authorData = typeof commit.author === 'object' && commit.author !== null
      ? commit.author as Record<string, unknown>
      : {};
    const committerData = typeof commit.committer === 'object' && commit.committer !== null
      ? commit.committer as Record<string, unknown>
      : {};
    const verification = typeof commit.verification === 'object' && commit.verification !== null
      ? commit.verification as Record<string, unknown>
      : null;
    const authorAccount = typeof row.author === 'object' && row.author !== null
      ? row.author as Record<string, unknown>
      : null;
    const committerAccount = typeof row.committer === 'object' && row.committer !== null
      ? row.committer as Record<string, unknown>
      : null;
    return [{
      sha: row.sha,
      message: typeof commit.message === 'string' ? commit.message.split('\n')[0]!.slice(0, 240) : '',
      date: typeof authorData.date === 'string'
        ? authorData.date
        : typeof committerData.date === 'string'
          ? committerData.date
          : null,
      author: typeof authorAccount?.login === 'string'
        ? authorAccount.login
        : typeof authorData.name === 'string'
          ? authorData.name
          : null,
      committer: typeof committerAccount?.login === 'string'
        ? committerAccount.login
        : typeof committerData.name === 'string'
          ? committerData.name
          : null,
      verified: typeof verification?.verified === 'boolean' ? verification.verified : null,
      url: typeof row.html_url === 'string' ? row.html_url : null
    }];
  });
  const unreadable = response.json.length - commits.length;
  return {
    commits,
    truncated: /rel="next"/.test(response.headers.get('Link') ?? ''),
    ...(unreadable > 0
      ? { unavailable: `GitHub commit history contained ${unreadable} unreadable entr${unreadable === 1 ? 'y' : 'ies'}; the visible history is partial.` }
      : {})
  };
}

export async function readCommitParents(
  request: GitHubRequest,
  repo: RepoRef,
  sha: string
): Promise<{ parents: string[]; unavailable?: string }> {
  const response = await request(`/repos/${repo.owner}/${repo.name}/git/commits/${encodeURIComponent(sha)}`);
  if (response.status !== 200) {
    return { parents: [], unavailable: `GitHub commit-parent lookup returned HTTP ${response.status}.` };
  }
  if (typeof response.json !== 'object' || response.json === null || Array.isArray(response.json)) {
    return { parents: [], unavailable: 'GitHub returned unreadable commit-parent data.' };
  }
  const body = response.json as { parents?: unknown };
  if (!Array.isArray(body.parents)) {
    return { parents: [], unavailable: 'GitHub commit-parent data did not include a readable parent list.' };
  }
  const parents = body.parents
    .map((parent) => parent.sha)
    .filter((parent): parent is string => typeof parent === 'string' && parent.length > 0);
  return { parents };
}

export interface DependencyVulnerability {
  severity: string;
  advisoryId: string;
  summary: string;
  url: string;
}

export interface DependencyChange {
  change: 'added' | 'removed';
  manifest: string;
  ecosystem: string;
  name: string;
  version: string;
  license: string | null;
  scope?: 'unknown' | 'runtime' | 'development';
  vulnerabilities: DependencyVulnerability[];
}

export interface DependencyReview {
  changes: DependencyChange[];
  truncated: boolean;
  unavailable?: string;
  snapshotWarning?: string;
}

function decodeHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
  } catch {
    return value;
  }
}

function parseDependencyChange(value: unknown): DependencyChange | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.change_type !== 'added' && row.change_type !== 'removed') return null;
  if (
    typeof row.manifest !== 'string' ||
    typeof row.ecosystem !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.version !== 'string'
  ) return null;

  const vulnerabilities = Array.isArray(row.vulnerabilities)
    ? row.vulnerabilities.flatMap((entry): DependencyVulnerability[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const finding = entry as Record<string, unknown>;
        if (
          typeof finding.severity !== 'string' ||
          typeof finding.advisory_ghsa_id !== 'string' ||
          typeof finding.advisory_summary !== 'string' ||
          typeof finding.advisory_url !== 'string'
        ) return [];
        return [{
          severity: finding.severity,
          advisoryId: finding.advisory_ghsa_id,
          summary: finding.advisory_summary,
          url: finding.advisory_url
        }];
      })
    : [];

  const scope = row.scope === 'runtime' || row.scope === 'development' || row.scope === 'unknown'
    ? row.scope
    : undefined;
  return {
    change: row.change_type,
    manifest: row.manifest,
    ecosystem: row.ecosystem,
    name: row.name,
    version: row.version,
    license: typeof row.license === 'string' ? row.license : null,
    ...(scope ? { scope } : {}),
    vulnerabilities
  };
}

export async function readDependencyReview(
  request: GitHubRequest,
  repo: RepoRef,
  base: string,
  head: string,
  maxPages = 3
): Promise<DependencyReview> {
  const changes: DependencyChange[] = [];
  let snapshotWarning: string | undefined;
  let truncated = false;
  const basehead = encodeURIComponent(`${base}...${head}`);

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await request(
      `/repos/${repo.owner}/${repo.name}/dependency-graph/compare/${basehead}?per_page=100&page=${page}`
    );
    if (response.status === 403) {
      return {
        changes: [],
        truncated: false,
        unavailable: 'GitHub dependency review is unavailable for this repository (private repositories require GitHub Code Security, and forks are not supported).'
      };
    }
    if (response.status === 404) {
      return { changes: [], truncated: false, unavailable: 'GitHub returned no dependency-review data for this repository.' };
    }
    if (response.status !== 200) {
      return {
        changes: [],
        truncated: false,
        unavailable: `GitHub dependency review returned HTTP ${response.status}.`
      };
    }

    snapshotWarning ??= decodeHeader(response.headers.get('x-github-dependency-graph-snapshot-warnings'));
    if (Array.isArray(response.json)) {
      for (const value of response.json) {
        const parsed = parseDependencyChange(value);
        if (parsed) changes.push(parsed);
      }
    }

    const hasNext = /rel="next"/.test(response.headers.get('Link') ?? '');
    if (!hasNext) break;
    if (page === maxPages) truncated = true;
  }

  return { changes, truncated, ...(snapshotWarning ? { snapshotWarning } : {}) };
}

export interface BranchRule {
  type: string;
  sourceType?: string;
  source?: string;
  parameters?: Record<string, unknown>;
}

export interface BranchPolicy {
  rules: BranchRule[];
  truncated: boolean;
  unavailable?: string;
}

export async function readBranchPolicy(
  request: GitHubRequest,
  repo: RepoRef,
  branch: string
): Promise<BranchPolicy> {
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('%2F');
  const response = await request(`/repos/${repo.owner}/${repo.name}/rules/branches/${encodedBranch}?per_page=100`);
  if (response.status === 404) return { rules: [], truncated: false };
  if (response.status !== 200) {
    return { rules: [], truncated: false, unavailable: `GitHub branch-rules lookup returned HTTP ${response.status}.` };
  }
  if (!Array.isArray(response.json)) {
    return { rules: [], truncated: false, unavailable: 'GitHub returned unreadable branch-rules data.' };
  }
  const rules = response.json.flatMap((value): BranchRule[] => {
    if (typeof value !== 'object' || value === null) return [];
    const row = value as Record<string, unknown>;
    if (typeof row.type !== 'string') return [];
    return [{
      type: row.type,
      ...(typeof row.ruleset_source_type === 'string' ? { sourceType: row.ruleset_source_type } : {}),
      ...(typeof row.ruleset_source === 'string' ? { source: row.ruleset_source } : {}),
      ...(typeof row.parameters === 'object' && row.parameters !== null
        ? { parameters: row.parameters as Record<string, unknown> }
        : {})
    }];
  });
  const unreadable = response.json.length - rules.length;
  return {
    rules,
    truncated: /rel="next"/.test(response.headers.get('Link') ?? '') || response.json.length >= 100,
    ...(unreadable > 0
      ? { unavailable: `GitHub branch-rules data contained ${unreadable} unreadable rule entr${unreadable === 1 ? 'y' : 'ies'}; policy evidence is partial.` }
      : {})
  };
}

export function requiredCheckNames(policy: BranchPolicy): string[] {
  const names: string[] = [];
  for (const rule of policy.rules) {
    if (rule.type !== 'required_status_checks') continue;
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks)) continue;
    for (const check of checks) {
      if (typeof check === 'object' && check !== null) {
        const context = (check as Record<string, unknown>).context;
        if (typeof context === 'string' && context.length > 0) names.push(context);
      }
    }
  }
  return [...new Set(names)];
}

export function requiredApprovalCount(policy: BranchPolicy): number {
  let required = 0;
  for (const rule of policy.rules) {
    if (rule.type !== 'pull_request') continue;
    const count = rule.parameters?.required_approving_review_count;
    if (typeof count === 'number' && Number.isFinite(count)) required = Math.max(required, Math.max(0, count));
  }
  return required;
}

export function requiresCodeOwnerReview(policy: BranchPolicy): boolean {
  return policy.rules.some(
    (rule) => rule.type === 'pull_request' && rule.parameters?.require_code_owner_review === true
  );
}

export function requiresReviewThreadResolution(policy: BranchPolicy): boolean {
  return policy.rules.some(
    (rule) => rule.type === 'pull_request' && rule.parameters?.required_review_thread_resolution === true
  );
}

export function requiresLastPushApproval(policy: BranchPolicy): boolean {
  return policy.rules.some(
    (rule) => rule.type === 'pull_request' && rule.parameters?.require_last_push_approval === true
  );
}

export interface PullReviewState {
  mergeable: boolean | null;
  draft: boolean | null;
  approvals: number;
  changesRequested: number;
  comments: number;
  truncated: boolean;
  unavailable?: string;
}

export async function readPullReviewState(
  request: GitHubRequest,
  repo: RepoRef,
  pullNumber: number
): Promise<PullReviewState> {
  const [pullResponse, reviewResponse] = await Promise.all([
    request(`/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}`),
    request(`/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}/reviews?per_page=100`)
  ]);

  if (pullResponse.status !== 200) {
    return {
      mergeable: null,
      draft: null,
      approvals: 0,
      changesRequested: 0,
      comments: 0,
      truncated: false,
      unavailable: `GitHub pull-request state returned HTTP ${pullResponse.status}.`
    };
  }

  const pull = typeof pullResponse.json === 'object' && pullResponse.json !== null
    ? pullResponse.json as Record<string, unknown>
    : {};
  const mergeable = typeof pull.mergeable === 'boolean' ? pull.mergeable : null;
  const draft = typeof pull.draft === 'boolean' ? pull.draft : null;

  if (reviewResponse.status !== 200 || !Array.isArray(reviewResponse.json)) {
    return {
      mergeable,
      draft,
      approvals: 0,
      changesRequested: 0,
      comments: 0,
      truncated: false,
      unavailable: `GitHub pull-request reviews returned HTTP ${reviewResponse.status}.`
    };
  }

  // GitHub returns reviews chronologically. Only APPROVED and
  // CHANGES_REQUESTED are decisive review states; a later COMMENTED review must
  // not erase an earlier approval. DISMISSED clears that reviewer's decisive
  // state. Comments are counted separately as review records, not reviewers.
  const decisive = new Map<string, 'APPROVED' | 'CHANGES_REQUESTED'>();
  let comments = 0;
  let anonymousIndex = 0;
  for (const value of reviewResponse.json) {
    if (typeof value !== 'object' || value === null) continue;
    const review = value as Record<string, unknown>;
    const state = typeof review.state === 'string' ? review.state.toUpperCase() : '';
    const user = typeof review.user === 'object' && review.user !== null
      ? review.user as Record<string, unknown>
      : null;
    const key = typeof user?.login === 'string' ? user.login : `anonymous-${anonymousIndex++}`;
    if (state === 'COMMENTED') {
      comments += 1;
      continue;
    }
    if (state === 'DISMISSED') {
      decisive.delete(key);
      continue;
    }
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') decisive.set(key, state);
  }

  const states = [...decisive.values()];
  return {
    mergeable,
    draft,
    approvals: states.filter((state) => state === 'APPROVED').length,
    changesRequested: states.filter((state) => state === 'CHANGES_REQUESTED').length,
    comments,
    truncated: /rel="next"/.test(reviewResponse.headers.get('Link') ?? '') || reviewResponse.json.length >= 100
  };
}

export interface CodeownersError {
  line?: number;
  column?: number;
  kind?: string;
  message: string;
  suggestion?: string;
}

export async function readCodeownersErrors(
  request: GitHubRequest,
  repo: RepoRef,
  ref: string
): Promise<{ errors: CodeownersError[]; unavailable?: string }> {
  const response = await request(
    `/repos/${repo.owner}/${repo.name}/codeowners/errors?ref=${encodeURIComponent(ref)}`
  );
  if (response.status === 404) return { errors: [] };
  if (response.status !== 200) {
    return { errors: [], unavailable: `GitHub CODEOWNERS validation returned HTTP ${response.status}.` };
  }
  if (typeof response.json !== 'object' || response.json === null || Array.isArray(response.json)) {
    return { errors: [], unavailable: 'GitHub returned unreadable CODEOWNERS validation data.' };
  }
  const body = response.json as Record<string, unknown>;
  if (!Array.isArray(body.errors)) {
    return { errors: [], unavailable: 'GitHub CODEOWNERS validation data did not include a readable error list.' };
  }
  const rawErrors = body.errors;
  const errors = rawErrors.flatMap((value): CodeownersError[] => {
    if (typeof value !== 'object' || value === null) return [];
    const error = value as Record<string, unknown>;
    const message = typeof error.message === 'string' ? error.message : typeof error.kind === 'string' ? error.kind : null;
    if (!message) return [];
    return [{
      ...(typeof error.line === 'number' ? { line: error.line } : {}),
      ...(typeof error.column === 'number' ? { column: error.column } : {}),
      ...(typeof error.kind === 'string' ? { kind: error.kind } : {}),
      message,
      ...(typeof error.suggestion === 'string' ? { suggestion: error.suggestion } : {})
    }];
  });
  return { errors };
}
