import { describe, expect, it } from 'vitest';
import { REMOVED_TOOLS, forgeTools } from '@forge/mcp-core';
import { branchPolicyFor, isAgentForgeBranch } from '../../packages/policy/src/branch-policy';

describe('branch policy for agents', () => {
  it('accepts forge task branches and rejects main/staged/backup', () => {
    expect(isAgentForgeBranch('forge/live-v1')).toBe(true);
    expect(isAgentForgeBranch('main')).toBe(false);
    expect(isAgentForgeBranch('forge/staged/ws_x/y')).toBe(false);
    expect(isAgentForgeBranch('forge/backup/ws_x')).toBe(false);
  });

  it('tells agents to create a forge branch when on main, naming a tool that exists', () => {
    const policy = branchPolicyFor('main');
    expect(policy.onAgentBranch).toBe(false);
    expect(policy.onDefaultBranch).toBe(true);

    // This used to assert the literal `forge_git_branch`, which pinned a dead
    // tool name in place long after the tool was removed — the test was holding
    // the bug open rather than catching it. Assert the property that actually
    // matters instead: whatever tool the guidance names must be one an agent
    // can really call.
    const named = policy.next_step.match(/forge_[a-z_]+/gu) ?? [];
    expect(named.length).toBeGreaterThan(0);
    const live = new Set(forgeTools.map((tool) => tool.name));
    for (const tool of named) {
      expect(REMOVED_TOOLS, `${tool} is a tombstone`).not.toHaveProperty(tool);
      expect(live, `${tool} is not in the catalog`).toContain(tool);
    }
  });
});
