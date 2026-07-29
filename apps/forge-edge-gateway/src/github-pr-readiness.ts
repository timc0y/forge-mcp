import type { GitHubRequest } from '@forge/git-github';

interface PullRequestBody {
  number: number;
  title: string;
  draft?: boolean;
  merged?: boolean;
  state: string;
  mergeable: boolean | null;
  mergeable_state?: string;
  merge_commit_sha?: string | null;
  head: { sha: string };
  base: { ref: string };
}

export interface PullRequestReadiness {
  number: number;
  title: string;
  head_sha: string;
  mergeable: boolean | null;
  mergeable_state: string;
  state: string;
  already_merged: boolean;
  merge_commit_sha: string | null;
  checks: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    failing: string[];
  };
  review_decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'NOT_REQUIRED' | 'UNKNOWN';
  safe_to_merge: boolean;
  blockers: string[];
}

async function paged<T>(request: GitHubRequest, path: string): Promise<{ values: T[]; error?: string }> {
  const values: T[] = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await request(`${path}${separator}per_page=100&page=${page}`);
    if (response.status !== 200) return { values, error: `HTTP ${response.status}` };
    const pageValues = Array.isArray(response.json)
      ? response.json as T[]
      : ((response.json as { check_runs?: T[] }).check_runs ?? []);
    values.push(...pageValues);
    if (pageValues.length < 100) return { values };
  }
}

function encodedRef(ref: string): string {
  return encodeURIComponent(ref);
}

/** Read every GitHub policy signal needed to make a fail-closed merge verdict. */
export async function readPullRequestReadiness(
  request: GitHubRequest,
  base: string,
  number: number
): Promise<PullRequestReadiness> {
  const pr = await request(`${base}/pulls/${number}`);
  if (pr.status !== 200) throw new Error(`Pull request #${number} read failed with HTTP ${pr.status}.`);
  const body = pr.json as PullRequestBody;
  const blockers: string[] = [];

  const runsResult = await paged<{ name: string; status: string; conclusion: string | null }>(
    request,
    `${base}/commits/${body.head.sha}/check-runs`
  );
  if (runsResult.error) blockers.push(`Check-run evidence unavailable (${runsResult.error}).`);

  const statusesResult = await paged<{ context: string; state: string }>(
    request,
    `${base}/commits/${body.head.sha}/statuses`
  );
  // The statuses endpoint returns history, newest first, and may contain many
  // old results for one context. Only the latest result for each context is a
  // current merge signal; counting an old failure would block the PR forever
  // after a later success.
  const latestStatusByContext = new Map<string, { context: string; state: string }>();
  for (const status of statusesResult.values) {
    if (!latestStatusByContext.has(status.context)) latestStatusByContext.set(status.context, status);
  }
  const statuses = [...latestStatusByContext.values()];
  if (statusesResult.error) blockers.push(`Classic status evidence unavailable (${statusesResult.error}).`);

  const reviewsResult = await paged<{
    state: string;
    submitted_at?: string;
    user?: { login?: string };
  }>(request, `${base}/pulls/${number}/reviews`);
  if (reviewsResult.error) blockers.push(`Review evidence unavailable (${reviewsResult.error}).`);

  const baseBranch = await request(`${base}/branches/${encodedRef(body.base.ref)}`);
  let requiredApprovals: number | undefined;
  let requiredContexts: string[] | undefined;
  if (baseBranch.status !== 200) {
    blockers.push(`Base-branch protection evidence unavailable (HTTP ${baseBranch.status}).`);
  } else if ((baseBranch.json as { protected?: boolean }).protected !== true) {
    requiredApprovals = 0;
    requiredContexts = [];
  } else {
    const protection = await request(`${base}/branches/${encodedRef(body.base.ref)}/protection`);
    if (protection.status !== 200) {
      blockers.push(`Required-review evidence unavailable (HTTP ${protection.status}).`);
    } else {
      const rules = protection.json as {
        required_pull_request_reviews?: { required_approving_review_count?: number } | null;
        required_status_checks?: {
          contexts?: string[];
          checks?: Array<{ context?: string }>;
        } | null;
      };
      requiredApprovals = Math.max(0, rules.required_pull_request_reviews?.required_approving_review_count ?? 0);
      requiredContexts = [
        ...(rules.required_status_checks?.contexts ?? []),
        ...(rules.required_status_checks?.checks ?? []).flatMap((check) => check.context ? [check.context] : [])
      ].filter((context, index, all) => all.indexOf(context) === index);
    }
  }

  const successfulConclusions = new Set(['success', 'neutral', 'skipped']);
  const failedRuns = runsResult.values.filter(
    (run) => run.status === 'completed' && run.conclusion !== null && !successfulConclusions.has(run.conclusion)
  );
  const pendingRuns = runsResult.values.filter((run) => run.status !== 'completed');
  const passedRuns = runsResult.values.filter(
    (run) => run.status === 'completed' && successfulConclusions.has(run.conclusion ?? '')
  );
  const failedStatuses = statuses.filter((status) => status.state === 'failure' || status.state === 'error');
  const pendingStatuses = statuses.filter((status) => status.state === 'pending');
  const passedStatuses = statuses.filter((status) => status.state === 'success');
  const failing = [...failedRuns.map((run) => run.name), ...failedStatuses.map((status) => status.context)];
  if (failing.length) blockers.push(`${failing.length} check/status context(s) failing: ${failing.join(', ')}.`);
  const pending = pendingRuns.length + pendingStatuses.length;
  if (pending) blockers.push(`${pending} check/status context(s) still pending.`);

  if (requiredContexts) {
    const successfulContexts = new Set([
      ...passedRuns.map((run) => run.name),
      ...passedStatuses.map((status) => status.context)
    ]);
    const missingRequired = requiredContexts.filter((context) => !successfulContexts.has(context));
    if (missingRequired.length) blockers.push(`Required status context(s) not successful: ${missingRequired.join(', ')}.`);
  }

  const latestReview = new Map<string, string>();
  const orderedReviews = [...reviewsResult.values].sort((left, right) =>
    String(left.submitted_at ?? '').localeCompare(String(right.submitted_at ?? ''))
  );
  for (const review of orderedReviews) {
    const login = review.user?.login;
    if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    latestReview.set(login, review.state);
  }
  const approvals = [...latestReview.values()].filter((state) => state === 'APPROVED').length;
  const changesRequested = [...latestReview.entries()]
    .filter(([, state]) => state === 'CHANGES_REQUESTED')
    .map(([login]) => login);
  let reviewDecision: PullRequestReadiness['review_decision'];
  if (reviewsResult.error || requiredApprovals === undefined) reviewDecision = 'UNKNOWN';
  else if (changesRequested.length) reviewDecision = 'CHANGES_REQUESTED';
  else if (requiredApprovals === 0) reviewDecision = 'NOT_REQUIRED';
  else if (approvals >= requiredApprovals) reviewDecision = 'APPROVED';
  else reviewDecision = 'REVIEW_REQUIRED';
  if (changesRequested.length) blockers.push(`Changes requested by: ${changesRequested.join(', ')}.`);
  if (requiredApprovals !== undefined && approvals < requiredApprovals) {
    blockers.push(`Requires ${requiredApprovals} approving review(s); ${approvals} effective approval(s) found.`);
  }

  const mergeableState = String(body.mergeable_state ?? 'unknown');
  if (body.merged) blockers.push('Already merged.');
  if (body.state !== 'open') blockers.push(`State is ${body.state}, not open.`);
  if (body.draft) blockers.push('Still a draft.');
  if (body.mergeable !== true) blockers.push(`GitHub mergeable verdict is ${String(body.mergeable)}.`);
  if (mergeableState !== 'clean') blockers.push(`GitHub mergeable state is ${mergeableState}, not clean.`);

  return {
    number: body.number,
    title: body.title,
    head_sha: body.head.sha,
    mergeable: body.mergeable,
    mergeable_state: mergeableState,
    state: body.state,
    already_merged: body.merged === true,
    merge_commit_sha: body.merge_commit_sha ?? null,
    checks: {
      total: runsResult.values.length + statuses.length,
      passed: passedRuns.length + passedStatuses.length,
      failed: failing.length,
      pending,
      failing
    },
    review_decision: reviewDecision,
    safe_to_merge: blockers.length === 0,
    blockers
  };
}
