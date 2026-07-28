import { ForgeError } from '@forge/core';

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
