import type { ToolContext, ToolOutcome } from './tool-types';
import { resolveRepositoryName } from './addresses';
import { findChange, openChanges } from './change';
import { Snapshot, resolveCommit } from './snapshot';
import { compare } from './read';
import { mergeEvidence, requireMergeEvidence } from './merge-evidence';
import { requestApproval } from './approve';

export async function prepareApproval(ctx: ToolContext, act: 'merge' | 'discard', repository: string, wanted: string): Promise<ToolOutcome> {
  const repo = await resolveRepositoryName(ctx.gh, repository, ctx.identity.githubLogin);
  const change = await findChange(ctx.gh, repo, wanted);
  const snapshot = await Snapshot.open(ctx.gh, repo, change.branch);
  const baseSha = await resolveCommit(snapshot.gh, repo, snapshot.branch);
  const comparison = await compare(snapshot.gh, repo, baseSha, snapshot.identity.sha);
  const report = act === 'merge' ? await mergeEvidence(snapshot, comparison, change.number) : null;
  if (report) requireMergeEvidence(report);
  const additions = comparison.files.reduce((n, file) => n + file.additions, 0);
  const deletions = comparison.files.reduce((n, file) => n + file.deletions, 0);
  const size = `${comparison.files.length} files, +${additions}/-${deletions}`;
  const evidence = act === 'merge'
    ? `Merge ${comparison.aheadBy} commits (${size}) into ${snapshot.branch}. Source ${snapshot.identity.sha}; base ${baseSha}.`
    : `Discard ${size}. ${comparison.aheadBy ? `${comparison.aheadBy} unmerged commits would stop being reachable from this branch.` : 'No unmerged commits would be lost.'}`;
  const prepared = await requestApproval(ctx.env, ctx.identity, { act, repo, change, comparison, headSha: snapshot.identity.sha, baseBranch: snapshot.branch });
  ctx.track('approval_requested', { act, files: comparison.files.length, commits: comparison.aheadBy, truncated: comparison.truncated });
  const limits = [...(report?.limitations ?? []), ...(comparison.truncated ? ['Comparison coverage is incomplete.'] : [])];
  let names: string[] | undefined;
  try { names = (await openChanges(ctx.gh, repo)).map((entry) => entry.name); }
  catch { limits.push('The latest open-change list could not be read. Approval creation is still durable.'); }
  return {
    summary: `${evidence} Nothing has been ${act === 'merge' ? 'merged' : 'discarded'}.`,
    structured: { approval: { url: prepared.url, expires: prepared.expiresAt }, evidence, ...(names ? { changes: names } : {}), limits, next: 'Open the approval link to review and decide. A changed head invalidates this approval.' }
  };
}
