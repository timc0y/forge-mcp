/**
 * Resolve workspace reads against GitHub, the durable repository authority.
 * Repository-scoped tree/blob behavior lives behind the GitHubRequest seam in
 * github-repository; this file only binds it to workspace state.
 */
import { ForgeError, type RepositoryRef } from '@forge/core';
import type { Env } from './env';
import { githubRequestForWorkspace } from './github';
import { githubRepository } from './github-repository';

export {
  GitHubReadUnavailable,
  listEntriesFromTree,
  readBlobFromTree
} from './github-repository';

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))
  ]);
}

/**
 * Resolve the workspace's current repository and branch, then fetch that
 * branch's complete GitHub tree with the same request used for later blobs.
 */
export async function resolveBranchTree(
  env: Env,
  identity: Parameters<typeof githubRequestForWorkspace>[1],
  workspace: { getAuthorizationBinding(): Promise<unknown> }
) {
  const state = await withTimeout(
    workspace.getAuthorizationBinding() as Promise<{ repository: RepositoryRef; requestedRef: string; currentBranch?: string }>,
    15_000
  );
  if (!state) {
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: 'The workspace did not respond in time, so Forge cannot tell which branch or repository to read from GitHub. Retry the same call — it usually succeeds on the next attempt.',
      retryable: true
    });
  }
  const branch = state.currentBranch ?? state.requestedRef;
  if (!branch) {
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: 'This workspace has no branch yet, so there is nothing on GitHub to read. Call forge_workspace_get to check readiness, or forge_workspace_create if it has not been created yet.',
      retryable: true
    });
  }
  const request = await githubRequestForWorkspace(env, identity, { repository: state.repository });
  const tree = await githubRepository(request, state.repository).readBranchTree(branch);
  return { repository: state.repository, branch, tree, request };
}
