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
  repositoryPathExists,
  readPullReviewState,
  requiredApprovalCount,
  requiredCheckNames,
  requiresCodeOwnerReview,
  requiresLastPushApproval,
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
  classifyChangedFileAreasWithJev,
  semanticPathTriageDetailed,
  summarizeChangeAssessment,
  type ChangeAssessment
} from './jev';
import { compare, readTree } from './read';
import {
  contractLikePaths,
  documentationCandidatePaths,
  hasChangesetFile,
  isDependencyManifestPath,
  isDocumentationLikePath,
  isTestLikePath,
  testCandidatePaths
} from './repository-intelligence';

export interface ChangeReviewPacket {
  policy: BranchPolicy;
  requiredChecks: string[];
  requiredApprovals: number;
  needsCodeOwnerReview: boolean;
  needsThreadResolution: boolean;
  needsLastPushApproval: boolean;
  reviewState: PullReviewState | null;
  dependencies: DependencyReview;
  dependencyVulnerabilities: Array<{
    dependency: DependencyChange;
    vulnerability: DependencyVulnerability;
  }>;
  assessment: ChangeAssessment | null;
  impactSummary?: string;
  assessmentFiles: number;
  usesChangesets: boolean | null;
  contractPaths: string[];
  suggestedTestPaths: string[];
  suggestedDocPaths: string[];
  companionTreeTruncated: boolean;
  splitGroups: Array<{ area: string; paths: string[] }>;
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
  const assessmentFiles = Math.min(20, comparison.files.length);
  const assessmentPromise: Promise<ChangeAssessment | null> = env.TYPESAFE_API_KEY && assessmentFiles > 0
    ? (async () => {
        try {
          const patchPaths = comparison.files.slice(0, assessmentFiles).map((file) => file.path);
          const enriched = await compare(gh, repo, base, change.branch, patchPaths);
          return await assessChangeWithJev(env, change.name, enriched);
        } catch {
          return null;
        }
      })()
    : Promise.resolve(null);

  const [policy, dependencies, reviewState, assessment] = await Promise.all([
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
      : Promise.resolve(null),
    assessmentPromise
  ]);

  const impactSummary = assessment
    ? summarizeChangeAssessment(assessment, comparison.files.length)
    : undefined;
  const releaseMetadataLooksRelevant = Boolean(
    assessment && (assessment.userVisible >= 0.8 || assessment.breakingChange >= 0.8 || assessment.docsRelevant >= 0.92)
  );
  const usesChangesets = releaseMetadataLooksRelevant
    ? await repositoryPathExists(gh, repo, base, '.changeset/config.json').catch(() => null)
    : null;

  const changedPaths = comparison.files.map((file) => file.path);
  const needsTestSuggestion = Boolean(
    assessment && assessment.testsRelevant >= 0.9 && !changedPaths.some(isTestLikePath)
  );
  const needsDocSuggestion = Boolean(
    assessment && assessment.docsRelevant >= 0.92 && !changedPaths.some(isDocumentationLikePath)
  );
  let suggestedTestPaths: string[] = [];
  let suggestedDocPaths: string[] = [];
  let companionTreeTruncated = false;
  let splitGroups: Array<{ area: string; paths: string[] }> = [];

  if (assessment && assessment.multipleConcerns >= 0.85 && comparison.files.length >= 3) {
    try {
      const classified = await classifyChangedFileAreasWithJev(env, comparison.files.slice(0, 12));
      const grouped = new Map<string, string[]>();
      for (const item of classified) {
        const paths = grouped.get(item.area) ?? [];
        paths.push(item.path);
        grouped.set(item.area, paths);
      }
      if (grouped.size >= 2) {
        splitGroups = [...grouped.entries()].map(([area, paths]) => ({ area, paths }));
      }
    } catch {
      // Split suggestions are advisory only.
    }
  }

  if (needsTestSuggestion || needsDocSuggestion) {
    try {
      const tree = await readTree(gh, repo, base);
      companionTreeTruncated = tree.truncated;
      const changedContext = changedPaths.slice(0, 12).join(', ');
      const tasks: Array<Promise<void>> = [];
      if (needsTestSuggestion) {
        const candidates = testCandidatePaths(tree.entries);
        if (candidates.length > 0) {
          tasks.push(
            semanticPathTriageDetailed(
              env,
              candidates,
              `Tests most likely related to change "${change.name}" touching: ${changedContext}`
            ).then((result) => {
              suggestedTestPaths = result?.paths.slice(0, 3) ?? [];
            })
          );
        }
      }
      if (needsDocSuggestion) {
        const candidates = documentationCandidatePaths(tree.entries);
        if (candidates.length > 0) {
          tasks.push(
            semanticPathTriageDetailed(
              env,
              candidates,
              `Documentation most likely related to change "${change.name}" touching: ${changedContext}`
            ).then((result) => {
              suggestedDocPaths = result?.paths.slice(0, 3) ?? [];
            })
          );
        }
      }
      await Promise.all(tasks);
    } catch {
      // Suggestions are optional semantic pointers, never merge requirements.
    }
  }

  return {
    policy,
    requiredChecks: requiredCheckNames(policy),
    requiredApprovals: requiredApprovalCount(policy),
    needsCodeOwnerReview: requiresCodeOwnerReview(policy),
    needsThreadResolution: requiresReviewThreadResolution(policy),
    needsLastPushApproval: requiresLastPushApproval(policy),
    reviewState,
    dependencies,
    dependencyVulnerabilities: dependencies.changes.flatMap((dependency) =>
      dependency.vulnerabilities.map((vulnerability) => ({ dependency, vulnerability }))
    ),
    assessment,
    ...(impactSummary ? { impactSummary } : {}),
    assessmentFiles,
    usesChangesets,
    contractPaths: contractLikePaths(comparison.files),
    suggestedTestPaths,
    suggestedDocPaths,
    companionTreeTruncated,
    splitGroups
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
  if (packet.needsLastPushApproval) notices.push('GitHub requires approval of the most recent reviewable push by someone other than its author.');
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
  if (
    packet.usesChangesets === true &&
    packet.assessment &&
    (packet.assessment.userVisible >= 0.8 || packet.assessment.breakingChange >= 0.8 || packet.assessment.docsRelevant >= 0.92) &&
    !hasChangesetFile(comparison.files)
  ) {
    notices.push('Release metadata notice: this repository uses Changesets and the diff looks release/user-facing, but no .changeset/*.md file is changed. This is advisory; repository policy may intentionally exempt the change.');
  }
  if (packet.contractPaths.length > 0) {
    notices.push(`Contract-file notice: ${packet.contractPaths.join(', ')} changed. Forge does not replace parser/compiler compatibility checks for these contracts.`);
  }
  if (packet.suggestedTestPaths.length > 0) {
    notices.push(`Jev test candidates: ${packet.suggestedTestPaths.join(', ')}. These are likely companion files, not proof that tests are missing or required.`);
  }
  if (packet.suggestedDocPaths.length > 0) {
    notices.push(`Jev documentation candidates: ${packet.suggestedDocPaths.join(', ')}. These are likely companion files, not proof that documentation is missing or required.`);
  }
  if (packet.splitGroups.length >= 2) {
    notices.push('Jev split candidates group changed files by likely technical concern. They are review aids, not an instruction to rewrite Git history.');
  }
  if (packet.companionTreeTruncated) {
    notices.push('GitHub truncated the repository tree used for companion-file suggestions, so other candidates may exist.');
  }
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
  if (packet.usesChangesets === true) lines.push('RELEASE changesets convention detected');
  if (packet.contractPaths.length > 0) lines.push(`CONTRACT ${packet.contractPaths.join(', ')}`);
  for (const path of packet.suggestedTestPaths) lines.push(`TEST? ${path}`);
  for (const path of packet.suggestedDocPaths) lines.push(`DOC? ${path}`);
  for (const group of packet.splitGroups) lines.push(`SPLIT? ${group.area} · ${group.paths.join(', ')}`);
  if (packet.requiredChecks.length > 0) lines.push(`POLICY checks · ${packet.requiredChecks.join(', ')}`);
  if (packet.requiredApprovals > 0) lines.push(`POLICY approvals · ${packet.requiredApprovals} required`);
  if (packet.needsCodeOwnerReview) lines.push('POLICY code-owner review required');
  if (packet.needsThreadResolution) lines.push('POLICY review-thread resolution required');
  if (packet.needsLastPushApproval) lines.push('POLICY latest push requires independent approval');
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
