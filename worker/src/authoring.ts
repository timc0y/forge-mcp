import type { ToolContext, ToolOutcome } from './tool-types';
import type { RepoRef, FileWrite, CommitReceipt } from './contracts';
import { formatRepo } from './contracts';
import { ForgeError, isForgeError, toForgeError } from './errors';
import { resolveRepositoryName } from './addresses';
import { defaultBranch, assertNotNearExisting, createRepo } from './repo';
import { listRepos } from './read';
import { CHANGE_BRANCH, openChanges, ensureDraftPullRequest } from './change';
import { commitFiles, validateWriteInput } from './write';
import { readCodeownersErrors } from './github-intelligence';
import { validateSource } from './structure';
import { assertNoHighSeveritySecretText } from './content-safety';

export interface EditInput { repo: string; change?: string; intent?: string; message: string; files: FileWrite[]; private?: boolean }
async function target(ctx: ToolContext, repo: RepoRef, description: string, privateRepo: boolean): Promise<{ base: string; created: boolean }> {
  try { return { base: await defaultBranch(ctx.gh, repo), created: false }; }
  catch (error) {
    if (!isForgeError(error) || error.code !== 'FORGE_NOT_FOUND') throw error;
    if (repo.owner.toLowerCase() !== ctx.identity.githubLogin.toLowerCase()) throw new ForgeError({ code: 'FORGE_NOT_FOUND', message: 'Forge only creates repositories on the signed-in account. Grant access to an existing organization repository instead.' });
    const reachable = await listRepos(ctx.gh);
    const exact = reachable.find((entry) => entry.repo.toLowerCase() === formatRepo(repo).toLowerCase());
    if (exact) throw new ForgeError({
      code: 'FORGE_CONFLICT',
      message: `${formatRepo(repo)} became reachable after the creation target was checked. No file content was sent. Inspect https://github.com/${formatRepo(repo)} and confirm its visibility before deliberately writing to the existing repository.`,
      details: { repo: formatRepo(repo), url: `https://github.com/${formatRepo(repo)}`, requestedPrivate: privateRepo }
    });
    assertNotNearExisting(repo.name, [...new Set(reachable.map((entry) => entry.repo.split('/')[1]!))]);
    let created: RepoRef;
    try { created = await createRepo(ctx.ghUser, repo.name, { private: privateRepo, description }); }
    catch (creationError) {
      if (!isForgeError(creationError) || creationError.code !== 'FORGE_VALIDATION_FAILED') throw creationError;
      throw new ForgeError({
        code: creationError.code,
        message: `${creationError.message} No file content was sent. Inspect https://github.com/${formatRepo(repo)} and confirm its visibility before deliberately writing to an existing repository, or retry creation with a different name.`,
        details: { repo: formatRepo(repo), url: `https://github.com/${formatRepo(repo)}`, requestedPrivate: privateRepo }
      });
    }
    try { return { base: await defaultBranch(ctx.gh, created), created: true }; }
    catch { throw new ForgeError({ code: 'FORGE_UPSTREAM_UNAVAILABLE', message: `Created https://github.com/${formatRepo(created)}, but its default branch could not be read. Repository creation is durable; inspect it before another write.` }); }
  }
}
export async function author(ctx: ToolContext, input: EditInput): Promise<ToolOutcome> {
  if (input.intent !== undefined) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The retired intent input is rejected. Refresh Forge’s catalog and use change for review work; nothing was written.' });
  if (!input.message?.trim()) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'A commit message is required.' });
  if (input.change && /^(?:forge|main|master|branch|review|proposal)$/i.test(input.change.trim())) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'change is the human review reason, not a branch/mode name. Say what needs review.' });
  validateWriteInput(input.message, input.files);
  for (const file of input.files) {
    if (typeof file.content !== 'string') continue;
    assertNoHighSeveritySecretText(file.content, 'Commit');
    validateSource(file.path, file.content);
  }
  const repo = await resolveRepositoryName(ctx.gh, input.repo, ctx.identity.githubLogin, true);
  const destination = await target(ctx, repo, input.message, input.private ?? true);
  const proposed = input.change !== undefined;
  const branch = proposed ? CHANGE_BRANCH : destination.base;
  let commit: CommitReceipt;
  try {
    if (proposed && branch === destination.base) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'The default branch cannot also be Forge’s reserved proposal branch.' });
    if (proposed && (await openChanges(ctx.gh, repo)).some((entry) => entry.branch !== CHANGE_BRANCH)) throw new ForgeError({ code: 'FORGE_CONFLICT', message: 'Resolve older Forge proposals before starting this fixed-branch change.' });
    commit = await commitFiles(ctx.gh, repo, branch, destination.base, input.message, input.files);
  } catch (thrown) {
    if (!destination.created) throw thrown;
    const error = toForgeError(thrown);
    throw new ForgeError({
      code: error.code,
      message: `Created https://github.com/${formatRepo(repo)} before the requested write failed. Repository creation is durable; inspect it before another write. ${error.message}`,
      retryable: false,
      details: { ...error.details, createdRepository: formatRepo(repo), url: `https://github.com/${formatRepo(repo)}` }
    });
  }
  if (commit.outcome === 'committed') ctx.track('change_committed', { files: commit.paths.length, created_repo: destination.created });
  // Every failure after this point is decoration on a write that is already durable.
  const limits = [...(commit.notes ?? [])];
  if (commit.outcome === 'committed' && input.files.some((file) => ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].includes(file.path))) {
    try {
      const ownership = await readCodeownersErrors(ctx.gh, repo, commit.sha);
      if (ownership.unavailable) limits.push(ownership.unavailable);
      for (const error of ownership.errors.slice(0, 10)) {
        const where = error.line ? ` line ${error.line}${error.column ? `:${error.column}` : ''}` : '';
        limits.push(`CODEOWNERS notice${where}: ${error.message}${error.suggestion ? ` ${error.suggestion}` : ''}`);
      }
      if (ownership.errors.length > 10) limits.push(`GitHub reported ${ownership.errors.length} CODEOWNERS errors; showing the first 10.`);
    } catch (error) {
      limits.push(`CODEOWNERS validation could not be completed after the durable commit: ${toForgeError(error).message}`);
    }
  }
  let number: number | null = null;
  let pullRequestUncertain = false;
  if (proposed) {
    try { number = await ensureDraftPullRequest(ctx.gh, repo, branch, input.change!, destination.base); }
    catch (thrown) {
      const error = toForgeError(thrown);
      pullRequestUncertain = error.details?.pullRequestCreation === 'uncertain';
      limits.push(pullRequestUncertain
        ? `The draft PR outcome was not confirmed. ${error.message} Source: ${commit.url} on https://github.com/${formatRepo(repo)}/tree/${branch}. Inspect https://github.com/${formatRepo(repo)}/pulls before requesting another draft PR.`
        : `Source is ${commit.outcome === 'committed' ? 'committed' : 'unchanged'} on ${branch}, but its draft PR could not be opened: ${error.message}`);
    }
    if (commit.outcome === 'unchanged' && number === null && !pullRequestUncertain) limits.push('No content changed and no pull request was opened. Forge leaves any existing proposal ref untouched.');
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
      next: pullRequestUncertain ? `Inspect https://github.com/${formatRepo(repo)}/pulls to establish the draft PR outcome before requesting another.` : proposed ? 'Read exact-commit checks and review the proposal before requesting merge approval.' : 'The edit is durable on GitHub; execution evidence is separate.'
    }
  };
}
