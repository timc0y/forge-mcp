import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forgeTools, type ForgeToolHandlers, type ForgeToolResponse } from '@forge/mcp-core';
import { toForgeError } from '@forge/core';

const FORGE_CONSOLE_URI = 'ui://forge/workspace-console';

const RETRY_SAFE_MUTATIONS = new Set([
  'forge_workspace_create', 'forge_files_write', 'forge_files_patch', 'forge_shell_exec', 'forge_process_start', 'forge_process_stop', 'forge_check_start', 'forge_check_cancel',
  'forge_git_branch_create', 'forge_git_commit', 'forge_git_push', 'forge_preview_expose',
  'forge_workspace_destroy', 'forge_work_export'
]);
const TRUE_READS = new Set([
  'forge_capabilities', 'forge_credential_list', 'forge_workspace_reconcile', 'forge_workspace_prove',
  'forge_repository_list', 'forge_workspace_get', 'forge_files_tree', 'forge_files_read',
  'forge_process_logs', 'forge_process_get', 'forge_check_get', 'forge_git_status', 'forge_git_diff', 'forge_git_outgoing_diff',
  'forge_artifact_get'
]);

export function toolAnnotations(name: string, sideEffect: 'none' | 'workspace' | 'external' | 'destructive') {
  const readOnly = TRUE_READS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: sideEffect === 'destructive',
    idempotentHint: readOnly || RETRY_SAFE_MUTATIONS.has(name)
  };
}

export function registerForgeToolsV1(server: McpServer, handlers: ForgeToolHandlers): void {
  for (const definition of forgeTools) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: toolAnnotations(definition.name, definition.sideEffect),
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
