import { describe, expect, it } from 'vitest';
import { forgeTools } from '@forge/mcp-core';
import { FORGE_MCP_INSTRUCTIONS } from '../../apps/forge-edge-gateway/src/mcp-guidance';

const names = forgeTools.map((tool) => tool.name);

describe('ordinary Chat direct journeys', () => {
  it('offers capabilities rather than control-plane lifecycles', () => {
    expect(names).toEqual([
      'forge_repositories', 'forge_search', 'forge_read', 'forge_edit',
      'forge_run', 'forge_screenshot', 'forge_environments', 'forge_deploy',
      'forge_submit', 'forge_status'
    ]);
    expect(names.join(' ')).not.toMatch(/workspace|process|task|secret|artifact|preview/u);
  });

  it('supports discover, inspect, durable edit, verify, screenshot, and submit', () => {
    expect(names).toEqual(expect.arrayContaining([
      'forge_repositories', 'forge_search', 'forge_read', 'forge_edit',
      'forge_run', 'forge_screenshot', 'forge_submit'
    ]));
  });

  it('keeps environment configuration private and deploy approval deferred', () => {
    const deploy = forgeTools.find((tool) => tool.name === 'forge_deploy');
    expect(deploy?.approval).toBe('deferred');
    expect(names).toContain('forge_environments');
    expect(names.join(' ')).not.toContain('secret');
  });

  it('does not instruct Chat to poll or retain private identifiers', () => {
    expect(FORGE_MCP_INSTRUCTIONS).not.toMatch(/workspace_id|process_id|task_id|poll/iu);
    expect(FORGE_MCP_INSTRUCTIONS).toContain('Repository reads and edits use GitHub as durable truth');
  });
});
