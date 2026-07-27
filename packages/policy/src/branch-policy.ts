import { ForgeError } from '@forge/core';

export function assertForgeBranch(branch: string): void {
  if (
    !/^forge\/[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/u.test(branch) ||
    branch.includes('..') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock')
  ) {
    throw new ForgeError({
      code: 'FORGE_GIT_PUSH_BLOCKED',
      message: 'Forge branches must use the forge/<task> namespace.',
      retryable: false
    });
  }
}

export function assertAllowedForgeBranch(branch: string, defaultBranch: string): void {
  if (branch === defaultBranch) throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'Direct pushes to the default branch are blocked.', retryable: false });
  assertForgeBranch(branch);
}
