import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forgeTools, type ForgeToolHandlers } from '@forge/mcp-core';
import { toForgeError } from '@forge/core';

export function registerForgeToolsV1(server: McpServer, handlers: ForgeToolHandlers): void {
  for (const definition of forgeTools) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: {
          readOnlyHint: definition.sideEffect === 'none',
          destructiveHint: definition.sideEffect === 'destructive',
          idempotentHint: definition.sideEffect !== 'destructive'
        }
      },
      async (input: Record<string, unknown>) => {
        try {
          const value = await handlers[definition.name](input as Record<string, unknown>);
          return {
            structuredContent: value,
            content: [{ type: 'text' as const, text: JSON.stringify(value) }]
          };
        } catch (error) {
          const shape = toForgeError(error).toJSON();
          const result = { error: shape };
          return {
            isError: true,
            structuredContent: result,
            content: [{ type: 'text' as const, text: JSON.stringify(result) }]
          };
        }
      }
    );
  }
}
