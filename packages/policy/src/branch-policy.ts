import { ForgeError } from '@forge/core';

export function assertAllowedForgeBranch(branch: string, defaultBranch: string): void {
  if (branch === defaultBranch) throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'Direct pushes to the default branch are blocked.', retryable: false });
  if (!/^forge\/[a-z0-9][a-z0-9._-]{0,38}\/[a-z0-9][a-z0-9._/-]{0,80}$/i.test(branch)) {
    throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'Branch must use forge/<actor>/<task> namespace.', retryable: false, details: { branch } });
  }
}
