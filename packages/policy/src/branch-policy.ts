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

/** True for agent work branches. */
export function isAgentForgeBranch(branch: string | undefined | null): branch is string {
  if (!branch?.startsWith('forge/')) return false;
  if (branch.startsWith('forge/backup/')) return false;
  if (branch.startsWith('forge/staged/')) return false;
  return true;
}

export function isDefaultGitBranch(branch: string | undefined | null): boolean {
  if (!branch) return true;
  return branch === 'main' || branch === 'master';
}

/** Branch policy guidance. */
export function branchPolicyFor(branch: string | undefined | null): {
  requiredPrefix: 'forge/';
  onAgentBranch: boolean;
  onDefaultBranch: boolean;
  currentBranch: string | null;
  next_step: string;
} {
  const onAgentBranch = isAgentForgeBranch(branch);
  const onDefaultBranch = isDefaultGitBranch(branch);
  return {
    requiredPrefix: 'forge/',
    onAgentBranch,
    onDefaultBranch,
    currentBranch: branch ?? null,
    next_step: onAgentBranch
      ? 'On your Forge branch. Edit with forge_edit — it commits straight to GitHub, so there is nothing to push.'
      : 'Not on a forge/<task> branch. Call forge_workspace_create — it cuts the branch for you; work on main/master is refused so it cannot be stranded or lost.'
  };
}

