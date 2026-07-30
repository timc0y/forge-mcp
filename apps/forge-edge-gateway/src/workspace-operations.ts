import type { WorkspaceCoordinator } from './workspace-coordinator';
import type { Env } from './env';

/**
 * The coordinator interface used by gateway callers and tests.
 *
 * Deployed Durable Object RPC names stay unchanged, while callers no longer
 * depend on the concrete Durable Object class or transport stub.
 */
export type WorkspaceOperations = Pick<
  WorkspaceCoordinator,
  | 'initialize'
  | 'getAuthorizationBinding'
  | 'provisionInitialized'
  | 'provisionExhausted'
  | 'tryGetState'
  | 'getState'
  | 'shellExec'
  | 'processStart'
  | 'processLogs'
  | 'processGet'
  | 'processStop'
  | 'processWait'
  | 'processCancel'
  | 'processList'
  | 'appendLiveActivity'
  | 'getObserverSnapshot'
  | 'operationGet'
  | 'dependenciesInstall'
  | 'rememberReads'
  | 'seenBlobs'
  | 'forgetReads'
  | 'beginGitHubEdit'
  | 'cancelGitHubEdit'
  | 'recordGitHubCommit'
  | 'ensureGitHubCheckout'
  | 'remoteMutationReplay'
  | 'recordRemoteMutation'
  | 'gitStatus'
  | 'startReviewPreview'
  | 'previewExpose'
  | 'getPreviewInternal'
  | 'requestDestroy'
  | 'completeDestroy'
>;

/** Cloudflare RPC adapter for the workspace-operations seam. */
export function workspaceOperations(env: Env, workspaceId: string): WorkspaceOperations {
  return env.WORKSPACE_COORDINATORS.get(
    env.WORKSPACE_COORDINATORS.idFromName(workspaceId)
  ) as unknown as WorkspaceOperations;
}
