import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forgeTools, type ForgeToolHandlers, type ForgeToolResponse } from '@forge/mcp-core';
import { toForgeError } from '@forge/core';
import type { ZodRawShape } from 'zod';

const RETRY_SAFE_MUTATIONS = new Set([
  'forge_workspace_create', 'forge_files_write', 'forge_files_patch', 'forge_shell_exec', 'forge_process_start', 'forge_process_stop', 'forge_check_start', 'forge_check_cancel',
  'forge_git_branch_create', 'forge_git_commit', 'forge_git_push', 'forge_preview_expose',
  'forge_workspace_destroy', 'forge_work_export'
]);
const TRUE_READS = new Set([
  'forge_capabilities', 'forge_credential_list', 'forge_workspace_reconcile', 'forge_workspace_prove',
  'forge_repository_list', 'forge_workspace_get', 'forge_files_tree', 'forge_files_read',
  'forge_process_logs', 'forge_process_get', 'forge_check_get', 'forge_git_status', 'forge_git_diff', 'forge_git_outgoing_diff',
  'forge_artifact_get', 'forge_task_get', 'forge_task_summary', 'forge_task_list',
  'forge_context_get', 'forge_diff_metadata'
]);

// Tools that reach the open world of arbitrary external URLs (not just the
// account's own GitHub App host or a workspace-scoped preview). forge_review
// takes a caller-supplied url and fetches it directly.
const OPEN_WORLD = new Set([
  'forge_review'
]);

// Short (<=64 char) ChatGPT status strings surfaced through result/tool _meta.
// NOTE: these are adapter-side defaults. The per-tool source of truth should
// move to ForgeToolDefinition in @forge/mcp-core (see report).
interface ToolInvocationStatus { invoking: string; invoked: string }
const TOOL_INVOCATION_STATUS: Partial<Record<string, ToolInvocationStatus>> = {
  forge_review: { invoking: 'Capturing screenshots…', invoked: 'Screenshots ready' },
  forge_review_capture: { invoking: 'Capturing review evidence…', invoked: 'Evidence captured' },
  forge_workspace_create: { invoking: 'Creating workspace…', invoked: 'Workspace requested' },
  forge_workspace_get: { invoking: 'Checking workspace…', invoked: 'Workspace status ready' },
  forge_workspace_destroy: { invoking: 'Destroying workspace…', invoked: 'Workspace destroyed' },
  forge_files_tree: { invoking: 'Listing files…', invoked: 'File tree ready' },
  forge_files_read: { invoking: 'Reading files…', invoked: 'Files read' },
  forge_files_write: { invoking: 'Writing file…', invoked: 'File written' },
  forge_files_patch: { invoking: 'Applying patch…', invoked: 'Patch applied' },
  forge_shell_exec: { invoking: 'Running command…', invoked: 'Command finished' },
  forge_process_start: { invoking: 'Starting process…', invoked: 'Process started' },
  forge_process_logs: { invoking: 'Reading logs…', invoked: 'Logs ready' },
  forge_git_status: { invoking: 'Reading Git status…', invoked: 'Git status ready' },
  forge_git_diff: { invoking: 'Reading Git diff…', invoked: 'Git diff ready' },
  forge_git_outgoing_diff: { invoking: 'Inspecting outgoing change…', invoked: 'Outgoing diff ready' },
  forge_git_branch_create: { invoking: 'Creating branch…', invoked: 'Branch created' },
  forge_git_commit: { invoking: 'Committing changes…', invoked: 'Commit created' },
  forge_git_push: { invoking: 'Pushing branch…', invoked: 'Branch pushed' },
  forge_pull_request_create: { invoking: 'Opening pull request…', invoked: 'Pull request created' },
  forge_preview_expose: { invoking: 'Exposing preview…', invoked: 'Preview ready' },
  forge_repository_list: { invoking: 'Listing repositories…', invoked: 'Repositories ready' },
  forge_artifact_get: { invoking: 'Fetching artifact…', invoked: 'Artifact ready' }
};

export function toolAnnotations(name: string, sideEffect: 'none' | 'workspace' | 'external' | 'destructive') {
  const readOnly = TRUE_READS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: sideEffect === 'destructive',
    idempotentHint: readOnly || RETRY_SAFE_MUTATIONS.has(name),
    openWorldHint: OPEN_WORLD.has(name)
  };
}

/**
 * Lift a component-only `_meta` object off a handler's returned value.
 *
 * SHARED DATA CONTRACT — handlers return `{ ...structuredFields, _meta }`.
 * The adapter strips `_meta` so it never reaches the model-visible
 * `structuredContent`, and attaches it to the MCP result's `_meta` so the host
 * forwards it to the widget. Bulk widget-only payloads (base64, evidence, large
 * tables) live under `_meta['forge/widget']`.
 */
function splitMeta(value: Record<string, unknown>): {
  structured: Record<string, unknown>;
  meta: Record<string, unknown> | undefined;
} {
  if (value && typeof value === 'object' && '_meta' in value) {
    const { _meta, ...structured } = value as { _meta?: unknown } & Record<string, unknown>;
    const meta = _meta && typeof _meta === 'object' ? (_meta as Record<string, unknown>) : undefined;
    return { structured, meta };
  }
  return { structured: value, meta: undefined };
}

/** Concise, single-line summary for the model — never the whole payload. */
function summarize(name: string, value: Record<string, unknown>): string {
  const pick = (k: string): string | undefined =>
    typeof value?.[k] === 'string' ? (value[k] as string) : undefined;
  return pick('nextStep') ?? pick('message') ?? pick('summary') ?? `${name} completed`;
}

export interface ToolCallTelemetry {
  tool: string;
  durationMs: number;
  status: 'success' | 'error';
  errorCode?: string;
  errorMessage?: string;
  resultBytes?: number;
  input: Record<string, unknown>;
}

export function registerForgeToolsV1(
  server: McpServer,
  handlers: ForgeToolHandlers,
  onToolCall?: (event: ToolCallTelemetry) => void
): void {
  for (const definition of forgeTools) {
    const status = TOOL_INVOCATION_STATUS[definition.name];
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        // Emit the declared output shape so clients can validate results and
        // render them structurally. Only the tools that carry one (see mcp-core);
        // the cast reads the optional field off the literal-typed tool union.
        ...((definition as { outputSchema?: ZodRawShape }).outputSchema
          ? { outputSchema: (definition as { outputSchema?: ZodRawShape }).outputSchema }
          : {}),
        annotations: toolAnnotations(definition.name, definition.sideEffect),
        // No `ui`/`openai/outputTemplate` here on purpose: Forge serves no
        // ui:// widget resource, so every tool result renders as the host's
        // own plain text/structured output. The only Forge-authored UI a
        // client ever shows is the hosted approval page at /approvals/:id.
        _meta: {
          ...(status
            ? {
                'openai/toolInvocation/invoking': status.invoking,
                'openai/toolInvocation/invoked': status.invoked
              }
            : {})
        }
      },
      async (input: Record<string, unknown>) => {
        const startedAt = Date.now();
        try {
          const result = await handlers[definition.name](input as Record<string, unknown>);
          const isResponse = (value: typeof result): value is ForgeToolResponse =>
            typeof value === 'object' &&
            value !== null &&
            'kind' in value &&
            value.kind === 'forge_tool_response';

          const rawValue = isResponse(result) ? result.value : result;
          const { structured, meta } = splitMeta(rawValue);

          // Bulk `_meta` a handler set aside (e.g. inline screenshot payloads)
          // rides on the result _meta alongside the per-tool ChatGPT status
          // strings, and stays out of the model-visible structuredContent.
          const resultMeta: Record<string, unknown> = {
            ...(status
              ? {
                  'openai/toolInvocation/invoking': status.invoking,
                  'openai/toolInvocation/invoked': status.invoked
                }
              : {}),
            ...(meta ?? {})
          };

          const response = {
            structuredContent: structured,
            // A ForgeToolResponse already carries purpose-built content (e.g.
            // image artifacts); otherwise emit a single short text summary
            // instead of JSON.stringify-ing the whole payload.
            content: isResponse(result)
              ? result.content
              : [{ type: 'text' as const, text: summarize(definition.name, structured) }],
            ...(Object.keys(resultMeta).length > 0 ? { _meta: resultMeta } : {})
          };

          onToolCall?.({
            tool: definition.name,
            durationMs: Date.now() - startedAt,
            status: 'success',
            resultBytes: JSON.stringify(response).length,
            input
          });

          return response;
        } catch (error) {
          const shape = toForgeError(error).toJSON();
          // Hoist structured error details (e.g. an approval requirement's
          // { kind, action, approval_id, approval_url, expires_at }) to the top
          // level so the model can read approval_url straight off
          // structuredContent and relay the link, rather than having to dig
          // through the nested error.details.
          const details =
            shape.details && typeof shape.details === 'object'
              ? (shape.details as Record<string, unknown>)
              : {};
          const result = { error: shape, ...details };

          onToolCall?.({
            tool: definition.name,
            durationMs: Date.now() - startedAt,
            status: 'error',
            errorCode: shape.code,
            errorMessage: shape.message,
            input
          });

          return {
            isError: true,
            structuredContent: result,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: shape }) }]
          };
        }
      }
    );
  }
}
