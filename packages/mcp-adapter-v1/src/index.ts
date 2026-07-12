import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forgeTools, type ForgeToolHandlers, type ForgeToolResponse } from '@forge/mcp-core';
import { toForgeError } from '@forge/core';

const FORGE_CONSOLE_URI = 'ui://forge/workspace-console';

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
        },
        _meta: {
          ui: { resourceUri: FORGE_CONSOLE_URI, visibility: ['model', 'app'] },
          'openai/outputTemplate': FORGE_CONSOLE_URI
        }
      },
      async (input: Record<string, unknown>) => {
        try {
          const result = await handlers[definition.name](input as Record<string, unknown>);
          const isResponse = (value: typeof result): value is ForgeToolResponse =>
            typeof value === 'object' &&
            value !== null &&
            'kind' in value &&
            value.kind === 'forge_tool_response';
          const value = isResponse(result) ? result.value : result;
          return {
            structuredContent: value,
            content: isResponse(result)
              ? result.content
              : [{ type: 'text' as const, text: JSON.stringify(value) }]
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
