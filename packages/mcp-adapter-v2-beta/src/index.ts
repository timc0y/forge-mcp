import type { ForgeToolDefinition, ForgeToolHandler } from '@forge/mcp-core';

export interface McpV2BetaPort {
  registerTool(definition: ForgeToolDefinition, handler: ForgeToolHandler): void;
}

export const MCP_V2_BETA_ENABLED = false;

export function registerForgeToolsV2Beta(): never {
  throw new Error('MCP SDK v2 beta is isolated from the production dependency graph until its contract package is pinned and compatibility tests pass.');
}
