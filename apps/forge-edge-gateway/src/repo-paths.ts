import { ForgeError } from '@forge/core';

/** Where the checkout lives in the container. */
export const REPO_ROOT = '/workspace/repo';

/**
 * Accept a path in either form an agent can be holding.
 *
 * forge_edit reports the paths it wrote repo-relative, and forge_files_list
 * lists them the same way — so demanding a /workspace prefix elsewhere meant
 * the exact string one tool handed back was rejected by the next. Both forms
 * resolve here, and traversal is still refused by normalizeRepoPath.
 */
export function toContainerPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '/workspace' || trimmed.startsWith('/workspace/')) return trimmed;
  return `${REPO_ROOT}/${normalizeRepoPath(trimmed)}`;
}

/** The path as git stores it, or a refusal. Nothing may escape the repository. */
export function normalizeRepoPath(path: string): string {
  const relative = path.replace(/^\/workspace\/repo\//u, '').replace(/^\.\//u, '').replace(/^\/+/u, '');
  if (!relative || relative.startsWith('../') || relative.includes('/../') || relative.endsWith('/..') || relative === '..' || relative.includes('\0')) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `"${path}" is not a path inside the repository.`,
      retryable: false
    });
  }
  return relative;
}
