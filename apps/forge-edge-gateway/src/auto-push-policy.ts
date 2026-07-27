import type { Env } from './env';
import { isAgentForgeBranch } from '@forge/policy';

export { isAgentForgeBranch };

/**
 * Push agent work on `forge/<task>` branches to GitHub without a per-push
 * approval click. Off only when FORGE_AUTO_PUSH_FORGE_BRANCHES is `false` or `0`.
 */
export function autoPushForgeBranchesEnabled(env: Pick<Env, 'FORGE_AUTO_PUSH_FORGE_BRANCHES'>): boolean {
  const flag = env.FORGE_AUTO_PUSH_FORGE_BRANCHES;
  return flag !== 'false' && flag !== '0';
}
