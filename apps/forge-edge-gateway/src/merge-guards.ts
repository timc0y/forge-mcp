import { ForgeError } from '@forge/core';

/**
 * forge_merge's two guards, extracted so a test can actually call them.
 *
 * mcp-session.ts cannot be imported outside a Workers runtime — it pulls in
 * `cloudflare:workers` transitively through the MCP agent framework — which is
 * why every earlier test of forge_merge could only scan its source text. This
 * file follows the same extraction as repo-paths.ts, command-summary.ts and
 * apply-replacements.ts: framework-free logic in the gateway, importable by
 * vitest. It deliberately does NOT live in @forge/mcp-core, which is the
 * declarative tool catalogue and should stay free of business logic.
 */

/** Structurally the same shape as @forge/git-github's GitHubRequest. */
export interface MinimalGitHubRequest {
  (path: string, init?: { method?: string; body?: unknown }): Promise<{
    status: number;
    json: unknown;
  }>;
}

/**
 * Refuse to fold uncommitted working-tree changes into forge_merge silently.
 *
 * forge_edit and forge_shell's own auto-commit both already push what they do
 * straight to origin, so a dirty tree here means something wrote to the
 * filesystem outside either of those — a raw shell write, an interrupted
 * process — bypassing the read-before-overwrite guard that makes a remote
 * commit safe. forge_merge used to commit and push that silently; naming the
 * files and pointing back at forge_edit is the honest version of the same
 * situation.
 */
export function assertCleanForMerge(status: { clean: boolean; changedPaths?: string[] } | undefined): void {
  if (!status || status.clean) return;
  const files = status.changedPaths?.length ? status.changedPaths.join(', ') : 'uncommitted changes';
  throw new ForgeError({
    code: 'FORGE_GIT_DIRTY',
    message: `The workspace has uncommitted changes forge_merge will not silently commit and push: ${files}. Re-apply them with forge_edit — it commits straight to GitHub — then call forge_merge again.`,
    retryable: false,
    details: { changedPaths: status.changedPaths ?? [] }
  });
}

/**
 * Read the branch's real head off GitHub. forge_merge used to fall back to
 * pushing (staging, then force-pushing the feature branch) when this came up
 * empty, which is the 403 this whole design removed: forge_merge must never
 * push. If the branch genuinely is not on origin, the fix is another
 * forge_edit — which commits directly — not a push from here.
 */
export async function verifyFeatureBranchOnOrigin(
  request: MinimalGitHubRequest,
  repository: { owner: string; name: string },
  branch: string
): Promise<string> {
  const response = await request(
    `/repos/${repository.owner}/${repository.name}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`
  ).catch(() => undefined);
  const remoteHead = response && response.status === 200
    ? (response.json as { object?: { sha?: string } }).object?.sha
    : undefined;
  if (!remoteHead) {
    throw new ForgeError({
      code: 'FORGE_GIT_PUSH_BLOCKED',
      message: `${branch} is not verified on GitHub yet, and forge_merge does not push branches to fix that. Re-apply the work with forge_edit — it commits straight to origin — then call forge_merge again.`,
      retryable: true,
      details: { branch }
    });
  }
  return remoteHead;
}
