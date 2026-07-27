import type { Env } from './env';

/**
 * Push agent work on `forge/<task>` branches to GitHub without a per-push
 * approval click. Off only when FORGE_AUTO_PUSH_FORGE_BRANCHES is `false` or `0`.
 */
export function autoPushForgeBranchesEnabled(env: Pick<Env, 'FORGE_AUTO_PUSH_FORGE_BRANCHES'>): boolean {
  const flag = env.FORGE_AUTO_PUSH_FORGE_BRANCHES;
  return flag !== 'false' && flag !== '0';
}

/** User-facing forge branches agents commit on — not Forge-internal refs. */
export function isAgentForgeBranch(branch: string | undefined | null): branch is string {
  if (!branch?.startsWith('forge/')) return false;
  if (branch.startsWith('forge/backup/')) return false;
  if (branch.startsWith('forge/staged/')) return false;
  return true;
}
