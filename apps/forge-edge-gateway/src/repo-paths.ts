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
/**
 * Trim a read result down to what an agent can act on.
 *
 * `sha256` went out on every file described as being "for a conflict-safe later
 * edit", but no tool input has ever accepted a hash — the read guard is
 * server-side, recorded when the file is read. It cost 66 bytes a file and
 * pointed at a workflow that does not exist. The path is reported repo-relative
 * for the same reason forge_files_list does: that is the form forge_edit takes.
 */
export function readableFile(file: Record<string, unknown>): Record<string, unknown> {
  const { sha256: _sha256, ...rest } = file;
  return typeof rest.path === 'string'
    ? { ...rest, path: normalizeRepoPath(rest.path) }
    : rest;
}

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
      message: `"${path}" is not a path inside the repository — it is empty, or escapes the repo root via "..". Use a path relative to the repository root (e.g. "src/a.ts"), or the exact string forge_files_list already returned.`,
      retryable: false
    });
  }
  return relative;
}
