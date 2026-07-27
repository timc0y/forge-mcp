import { describe, expect, it } from 'vitest';
import { MCP_V2_BETA_ENABLED, registerForgeToolsV2Beta } from '@forge/mcp-adapter-v2-beta';

describe('mcp-adapter-v2-beta package', () => {
  it('has beta flag disabled', () => {
    expect(MCP_V2_BETA_ENABLED).toBe(false);
  });

  it('throws on invocation of unpinned beta adapter', () => {
    expect(() => registerForgeToolsV2Beta()).toThrow(
      'MCP SDK v2 beta is isolated from the production dependency graph'
    );
  });
});
