/**
 * One bounded review packet over a proposed Forge change.
 *
 * GitHub supplies facts (policy, reviews, dependency diff, patches). Jev adds
 * semantic judgments over bounded patch evidence. Nothing here merges, polls,
 * runs repository code, or stores a second copy of repository state.
 */
import type { Change, Comparison, GitHubRequest, RepoRef } from './contracts';
import type { Env } from './env';
import {
  readBranchPolicy,
  readDependencyReview,
  readPullReviewState,
  requiredApprovalCount,
  requiredCheckNames,
  requiresCodeOwnerReview,
  requiresReviewThreadResolution,
  type BranchPolicy,
  type DependencyChange,
  type DependencyReview,
  type DependencyVulnerability,
  type PullReviewState
} from './github-intelligence';
import {
  assessChangeWithJev,
  changeAssessmentNotices,
  summarizeChangeAssessment,
  type ChangeAssessment
} from './jev';
import { compare } from './read';
import { isDependencyManifestPath } from './repository-intelligence';

export interface ChangeReviewPacket {
  policy: BranchPolicy;
  requiredChecks: string[];
  requiredApprovals: number;
  needsCodeOwnerReview: boolean;
  needsThreadResolution: boolean;
  reviewState: PullReviewState | null;
  dependencies: DependencyReview;
  dependencyVulnerabilities: Array<{
    dependency: DependencyChange;
    vulnerability: DependencyVulnerability;
  }>;
  assessment: ChangeAssessment | null;
  impactSummary?: string;
  assessmentFiles: number;
}

export async function buildChangeReviewPacket(
  env: Env,
  gh: GitHubRequest,
  repo: RepoRef,
  base: string,
  change: Change,
  comparison: Comparison
): Promise<ChangeReviewPacket> {
  const dependencyFilesChanged = comparison.files.some((file) => isDependencyManifestPath(file.path));
  const [policy, dependencies, reviewState] = await Promise.all([
    readBranchPolicy(gh, repo, base).catch(() => ({
      rules: [], truncated: false, unavailable: 'Branch policy could not be read.'
    })),
    dependencyFilesChanged
      ? readDependencyReview(gh, repo, base, change.branch).catch(() => ({
          changes: [], truncated: false, unavailable: 'Dependency review could not be read.'
        }))
      : Promise.resolve({ changes: [], truncated: false }),
    change.number !== null
      ? readPullReviewState(gh, repo, change.number).catch(() => null)
      : Promise.resolve(null)
  ]);

  let assessment: ChangeAssessment | null = null;
  let impactSummary: string | undefined;
  const assessmentFiles = Math.min(20, comparison.files.length);
  if (env.TYPESAFE_API_KEY && assessmentFiles > 0) {
    try {
      const patchPaths = comparison.files.slice(0, assessmentFiles).map((file) => file.path);
      const enriched = await compare(gh, repo, base, change.branch, patchPaths);
      assessment = await assessChangeWithJev(env, change.name, enriched);
      if (assessment) impactSummary = summarizeChangeAssessment(assessment, comparison.files.length);
    } catch {
      // Deterministic GitHub evidence still makes the packet useful.
    }
  }

  return {
    policy,
    requiredChecks: requiredCheckNames(policy),
    requiredApprovals: requiredApprovalCount(policy),
    needsCodeOwnerReview: requiresCodeOwnerReview(policy),
    needsThreadResolution: requiresReviewThreadResolution(policy),
    reviewState,
    dependencies,
    dependencyVulnerabilities: dependencies.changes.flatMap((dependency) =>
      dependency.vulnerabilities.map((vulnerability) => ({ dependency, vulnerability }))
    ),
    assessment,
    ...(impactSummary ? { impactSummary } : {}),
    assessmentFiles
  };
}

export function changeReviewNotices(
  packet: ChangeReviewPacket,
  comparison: Comparison,
  base: string
): string[] {
  const notices: string[] = [];
  if (packet.assessment) notices.push(...changeAssessmentNotices(packet.assessment, comparison));
  if (packet.assessment && comparison.files.length > packet.assessmentFiles) {
    notices.push(
      `Jev change assessment used patch evidence from the first ${packet.assessmentFiles} of ${comparison.files.length} changed files; deterministic GitHub evidence still covers the full comparison GitHub returned.`
    );
  }
  if (packet.policy.unavailable) notices.push(packet.policy.unavailable);
  if (packet.policy.truncated) notices.push('GitHub returned more than 100 active branch rules; policy evidence is incomplete.');
  if (packet.requiredChecks.length > 0) {
    notices.push(
      `GitHub requires these checks on ${base}: ${packet.requiredChecks.join(', ')}. Forge can see the rule names but not their current pass/fail state with its present permissions.`
    );
  }
  if (packet.requiredApprovals > 0) {
    const current = packet.reviewState?.approvals;
    notices.push(
      current === undefined
        ? `GitHub requires ${packet.requiredApprovals} approving review${packet.requiredApprovals === 1 ? '' : 's'} before merge.`
        : `GitHub requires ${packet.requiredApprovals} approving review${packet.requiredApprovals === 1 ? '' : 's'}; the latest review states currently show ${current} approval${current === 1 ? '' : 's'}.`
    );
  }
  if (packet.needsCodeOwnerReview) notices.push('GitHub requires code-owner review for matching changed files.');
  if (packet.needsThreadResolution) notices.push('GitHub requires review threads to be resolved before merge.');
  if (packet.reviewState?.unavailable) notices.push(packet.reviewState.unavailable);
  if (packet.reviewState?.changesRequested && packet.reviewState.changesRequested > 0) {
    notices.push(
      `The latest GitHub review states include ${packet.reviewState.changesRequested} change-requested review${packet.reviewState.changesRequested === 1 ? '' : 's'}.`
    );
  }
  if (packet.reviewState?.mergeable === false) {
    notices.push('GitHub currently reports this pull request as not automatically mergeable.');
  } else if (packet.reviewState?.mergeable === null && packet.reviewState && !packet.reviewState.unavailable) {
    notices.push('GitHub has not finished computing pull-request mergeability; Forge does not poll, so this remains unknown.');
  }
  if (packet.reviewState?.truncated) notices.push('Pull-request review state is based on the first 100 review records only.');
  if (packet.dependencies.unavailable) notices.push(packet.dependencies.unavailable);
  if (packet.dependencies.snapshotWarning) notices.push(`GitHub dependency snapshot warning: ${packet.dependencies.snapshotWarning}`);
  if (packet.dependencies.truncated) notices.push('Dependency review was capped at 300 dependency changes.');
  if (packet.dependencyVulnerabilities.length > 0) {
    const severities = [...new Set(packet.dependencyVulnerabilities.map((finding) => finding.vulnerability.severity))];
    notices.push(
      `GitHub dependency review reports ${packet.dependencyVulnerabilities.length} vulnerability finding${packet.dependencyVulnerabilities.length === 1 ? '' : 's'} in dependency changes${severities.length ? ` (${severities.join(', ')})` : ''}. Inspect them before approving.`
    );
  }
  return notices;
}

export function changeReviewLines(packet: ChangeReviewPacket): string[] {
  const lines: string[] = [];
  if (packet.impactSummary) lines.push(`JEV ${packet.impactSummary}`);
  if (packet.requiredChecks.length > 0) lines.push(`POLICY checks · ${packet.requiredChecks.join(', ')}`);
  if (packet.requiredApprovals > 0) lines.push(`POLICY approvals · ${packet.requiredApprovals} required`);
  if (packet.needsCodeOwnerReview) lines.push('POLICY code-owner review required');
  if (packet.needsThreadResolution) lines.push('POLICY review-thread resolution required');
  if (packet.reviewState) {
    const mergeable = packet.reviewState.mergeable === null ? 'unknown' : packet.reviewState.mergeable ? 'yes' : 'no';
    lines.push(
      `REVIEWS approvals ${packet.reviewState.approvals} · changes requested ${packet.reviewState.changesRequested} · comments ${packet.reviewState.comments} · mergeable ${mergeable}`
    );
  }
  if (packet.dependencies.changes.length > 0) {
    const added = packet.dependencies.changes.filter((dependency) => dependency.change === 'added').length;
    const removed = packet.dependencies.changes.filter((dependency) => dependency.change === 'removed').length;
    lines.push(`DEPENDENCIES +${added}/-${removed} · vulnerabilities ${packet.dependencyVulnerabilities.length}`);
  }
  for (const finding of packet.dependencyVulnerabilities.slice(0, 5)) {
    lines.push(
      `VULNERABILITY ${finding.vulnerability.severity} ${finding.vulnerability.advisoryId} · ${finding.dependency.name}@${finding.dependency.version}`
    );
  }
  return lines;
}
