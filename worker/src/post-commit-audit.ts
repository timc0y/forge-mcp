/**
 * Semantic audit that runs only after an ordinary Forge commit is durable.
 *
 * This never blocks or rewrites work. It compares the real parent -> committed
 * SHA on GitHub, then asks Jev narrow questions over bounded patch evidence.
 * A failure here is decoration failure, never commit failure.
 */
import type { Env } from './env';
import type { GitHubRequest, RepoRef } from './contracts';
import { readCommitParents } from './github-intelligence';
import { assessChangeWithJev, changeAssessmentNotices, summarizeChangeAssessment } from './jev';
import { compare } from './read';
import { isDocumentationLikePath } from './repository-intelligence';

export async function auditDurableCommitWithJev(
  env: Env,
  request: GitHubRequest,
  repo: RepoRef,
  sha: string,
  intent: string,
  paths: string[]
): Promise<string[]> {
  if (!env.TYPESAFE_API_KEY || paths.length === 0) return [];
  if (paths.every(isDocumentationLikePath)) return [];

  const parent = await readCommitParents(request, repo, sha);
  if (parent.unavailable) return [parent.unavailable];
  const parentSha = parent.parents[0];
  if (!parentSha) return [];

  const patchPaths = paths.slice(0, 10);
  const comparison = await compare(request, repo, parentSha, sha, patchPaths);
  const assessment = await assessChangeWithJev(env, intent, comparison);
  if (!assessment) return [];

  const notices = [
    `Post-commit Jev audit: ${summarizeChangeAssessment(assessment, comparison.files.length)}`,
    ...changeAssessmentNotices(assessment, comparison).map((notice) =>
      notice.replace(/^Jev notice:/, 'Post-commit Jev notice:')
    )
  ];
  if (comparison.files.length > patchPaths.length) {
    notices.push(
      `Post-commit Jev audit used patch evidence from the first ${patchPaths.length} of ${comparison.files.length} changed files.`
    );
  }
  if (comparison.truncated) {
    notices.push('Post-commit Jev audit used a GitHub comparison whose changed-file list was truncated.');
  }
  return notices;
}
