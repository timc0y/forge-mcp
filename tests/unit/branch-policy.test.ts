import { describe, expect, it } from 'vitest';
import { branchPolicyFor, isAgentForgeBranch } from '../../packages/policy/src/branch-policy';

describe('branch policy for agents', () => {
  it('accepts forge task branches and rejects main/staged/backup', () => {
    expect(isAgentForgeBranch('forge/live-v1')).toBe(true);
    expect(isAgentForgeBranch('main')).toBe(false);
    expect(isAgentForgeBranch('forge/staged/ws_x/y')).toBe(false);
    expect(isAgentForgeBranch('forge/backup/ws_x')).toBe(false);
  });

  it('tells agents to create a forge branch when on main', () => {
    const policy = branchPolicyFor('main');
    expect(policy.onAgentBranch).toBe(false);
    expect(policy.onDefaultBranch).toBe(true);
    expect(policy.next_step).toMatch(/forge_git_branch/);
  });
});
