/**
 * Read-only repository intelligence GitHub can answer directly.
 *
 * These calls deliberately use APIs backed by the repository's committed state
 * and existing Forge permissions. No checkout, runner, polling, or stored copy.
 */
import type { GitHubRequest, RepoRef } from './contracts';

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
  const rules = Array.isArray(response.json)
    ? response.json.flatMap((value): BranchRule[] => {
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
      })
    : [];
  return {
    rules,
    truncated: /rel="next"/.test(response.headers.get('Link') ?? '') || rules.length >= 100
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
