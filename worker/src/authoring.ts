import type { ToolContext, ToolOutcome } from './tool-types';
import type { RepoRef, FileWrite } from './contracts';
import { formatRepo } from './contracts';
import { ForgeError, isForgeError, toForgeError } from './errors';
import { resolveRepositoryName } from './addresses';
import { defaultBranch, assertNotNearExisting, createRepo } from './repo';
import { listRepos } from './read';
import { CHANGE_BRANCH, openChanges, ensureDraftPullRequest } from './change';
import { commitFiles } from './write';

export interface EditInput { repo: string; change?: string; intent?: string; message: string; files: FileWrite[]; private?: boolean }
async function target(ctx: ToolContext, repo: RepoRef, description: string, privateRepo: boolean): Promise<{ base: string; created: boolean }> {
  try { return { base: await defaultBranch(ctx.gh, repo), created: false }; }
  catch (error) {
    if (!isForgeError(error) || error.code !== 'FORGE_NOT_FOUND') throw error;
    if (repo.owner.toLowerCase() !== ctx.identity.githubLogin.toLowerCase()) throw new ForgeError({ code: 'FORGE_NOT_FOUND', message: 'Forge only creates repositories on the signed-in account. Grant access to an existing organization repository instead.' });
    const reachable = await listRepos(ctx.gh);
    const exact = reachable.find((entry) => entry.repo.toLowerCase() === formatRepo(repo).toLowerCase());
    if (exact) return { base: exact.defaultBranch, created: false };
    assertNotNearExisting(repo.name, [...new Set(reachable.map((entry) => entry.repo.split('/')[1]!))]);
    let created: RepoRef;
    try { created = await createRepo(ctx.ghUser, repo.name, { private: privateRepo, description }); }
    catch (creationError) {
      // GitHub arbitrates a concurrent creation, not an alternate write target.
      if (!isForgeError(creationError) || creationError.code !== 'FORGE_VALIDATION_FAILED') throw creationError;
      try { return { base: await defaultBranch(ctx.gh, repo), created: false }; } catch { throw creationError; }
    }
    try { return { base: await defaultBranch(ctx.gh, created), created: true }; }
    catch { throw new ForgeError({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: `Created ${formatRepo(created)}, but its default branch could not be read. Repository creation is durable; inspect it before another write.` }); }
  }
}
export async function author(ctx: ToolContext, input: EditInput): Promise<ToolOutcome> {
  if (input.intent !== undefined) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The retired intent input is rejected. Refresh Forge’s catalog and use change for review work; nothing was written.' });
  if (!input.message?.trim()) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'A commit message is required.' });
  if (input.change && /^(?:forge|main|master)$/i.test(input.change)) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'change is the review reason, not a branch name.' });
  const repo = await resolveRepositoryName(ctx.gh, input.repo, ctx.identity.githubLogin, true);
  const destination = await target(ctx, repo, input.message, input.private ?? true);
  const proposed = input.change !== undefined;
  const branch = proposed ? CHANGE_BRANCH : destination.base;
  if (proposed && branch === destination.base) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The default branch cannot also be Forge’s reserved proposal branch.' });
  if (proposed && (await openChanges(ctx.gh, repo)).some((entry) => entry.branch !== CHANGE_BRANCH)) throw new ForgeError({ code: 'FORGE_CONFLICT', message: 'Resolve older Forge proposals before starting this fixed-branch change.' });
  const commit = await commitFiles(ctx.gh, repo, branch, destination.base, input.message, input.files);
  if (commit.outcome === 'committed') ctx.track('change_committed', { files: commit.paths.length, created_repo: destination.created });
  // Every failure after this point is decoration on a write that is already durable.
  const limits = [...(commit.notes ?? [])];
  let number: number | null = null;
  if (proposed) {
    try { number = await ensureDraftPullRequest(ctx.gh, repo, branch, input.change!, destination.base); }
    catch (error) { limits.push(`Committed on ${branch}, but its draft PR could not be opened: ${toForgeError(error).message}`); }
  }
  let names: string[] | undefined;
  try { names = (await openChanges(ctx.gh, repo)).map((entry) => entry.name); }
  catch { limits.push('Open changes could not be listed; the commit receipt remains authoritative.'); }
  if (commit.outcome === 'unchanged') limits.push('No commit was created; source already matched.');
  return {
    summary: `${commit.outcome === 'committed' ? 'Committed' : 'Already matched'} ${commit.paths.length} files on ${branch} in ${formatRepo(repo)} (${commit.sha.slice(0, 7)}).`,
    structured: {
      commit: { repo: commit.repo, branch: commit.branch, sha: commit.sha, url: commit.url, outcome: commit.outcome },
      ...(proposed ? { change: 'forge' } : {}), ...(number !== null ? { review: `https://github.com/${formatRepo(repo)}/pull/${number}` } : {}),
      ...(names ? { changes: names } : {}), limits,
      next: proposed ? 'Read exact-commit checks and review the proposal before requesting merge approval.' : 'The edit is durable on GitHub; execution evidence is separate.'
    }
  };
}
