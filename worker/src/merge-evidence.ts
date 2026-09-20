import type { Comparison } from './contracts';
import type { Snapshot } from './snapshot';
import { readChecks, failedChecks, requiredChecksSatisfied } from './checks';
import { readBranchPolicy, readPullReviewState, requiredCheckNames, requiredApprovalCount } from './github-intelligence';
import { inspectStructure } from './structure';
import { mapBounded } from './evidence';
import { ForgeError, toForgeError } from './errors';

/** Current GitHub facts and parser findings, never a model-certified merge decision. */
export async function mergeEvidence(snapshot: Snapshot, comparison: Comparison, pullNumber: number | null) {
  const checks = await readChecks(snapshot.gh, snapshot.repo, snapshot.identity.sha);
  const policy = await readBranchPolicy(snapshot.gh, snapshot.repo, snapshot.branch);
  const reviews = pullNumber === null ? null : await readPullReviewState(snapshot.gh, snapshot.repo, pullNumber);
  const sourcePaths = comparison.files.filter((file) => file.status !== 'removed' && /\.(?:[cm]?[jt]sx?|jsonc?)$/i.test(file.path)).map((file) => file.path);
  const structural = await mapBounded(sourcePaths.slice(0, 24), async (path) => {
    try {
      const file = await snapshot.file(path);
      const result = inspectStructure(path, file.text);
      return { path, coverage: result.supported ? 'complete' : 'unsupported', diagnostics: result.diagnostics };
    } catch (error) { return { path, coverage: 'unavailable', diagnostics: [], error: toForgeError(error).message }; }
  });
  const required = requiredCheckNames(policy);
  const blockers = structural.flatMap((entry) => entry.diagnostics.map((diagnostic) => `${entry.path}:${diagnostic.line}: parser error`));
  blockers.push(...failedChecks(checks).map((check) => `Check ${check.name}: ${check.conclusion}`));
  if (reviews?.changesRequested) blockers.push('GitHub reviews request changes.');
  if (reviews?.mergeable === false) blockers.push('GitHub reports this change is not automatically mergeable.');
  if (required.length && !requiredChecksSatisfied(checks, required)) blockers.push('Required checks are not all successful on this exact head revision. Synthetic merge checks must be inspected as separate evidence.');
  const minimumApprovals = requiredApprovalCount(policy);
  if (minimumApprovals && (!reviews || reviews.approvals < minimumApprovals)) blockers.push('Required independent GitHub approvals have not been established.');
  const limitations = [
    ...(policy.unavailable ? [policy.unavailable] : []),
    ...(policy.truncated ? ['Branch rules are incomplete.'] : []),
    ...(reviews?.unavailable ? [reviews.unavailable] : []),
    ...(comparison.truncated ? ['The changed-file list is incomplete.'] : []),
    ...(sourcePaths.length > structural.length ? ['Parser validation is bounded to the first 24 changed supported source files.'] : []),
    ...structural.filter((entry) => entry.coverage !== 'complete').map((entry) => `${entry.path}: structural validation unavailable.`),
    'Syntax validation is not type checking, tests or deployed behavior.'
  ];
  return { headSha: snapshot.identity.sha, checks, policy, reviews, structural, blockers, limitations };
}
export function requireMergeEvidence(report: Awaited<ReturnType<typeof mergeEvidence>>): void {
  if (report.blockers.length) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `Merge approval was not created. Repair the known blockers first: ${report.blockers.join(' ')}` });
  if (report.policy.unavailable || report.policy.truncated) throw new ForgeError({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: 'Merge approval was not created because GitHub policy could not be established. No permissive policy was substituted.' });
  if (report.checks.coverage !== 'complete') throw new ForgeError({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: 'Merge approval was not created because exact-head check evidence is incomplete or unavailable. Grant Checks read access or resolve the GitHub evidence gap; no inferred test state was substituted.' });
}
