import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forgeTools, type ForgeToolHandlers, type ForgeToolResponse } from '@forge/mcp-core';
import { toForgeError } from '@forge/core';
import type { ZodRawShape } from 'zod';

const FORGE_CONSOLE_URI = 'ui://forge/workspace-console';

const RETRY_SAFE_MUTATIONS = new Set([
  'forge_workspace_create', 'forge_files_patch', 'forge_shell_exec', 'forge_process_start',
  'forge_git_branch_create', 'forge_git_commit', 'forge_git_push', 'forge_preview_expose',
  'forge_workspace_destroy'
]);
const TRUE_READS = new Set([
  'forge_repository_list', 'forge_workspace_get', 'forge_files_tree', 'forge_files_read',
  'forge_process_logs', 'forge_git_status', 'forge_git_diff', 'forge_git_outgoing_diff',
  'forge_artifact_get', 'forge_task_get', 'forge_task_summary', 'forge_task_list',
  'forge_context_get', 'forge_diff_metadata'
]);

// Tools that reach the open world of arbitrary external URLs (not just the
// account's own GitHub App host or a workspace-scoped preview). forge_review
// takes a caller-supplied url and fetches it directly.
const OPEN_WORLD = new Set([
  'forge_review'
]);

// Tools whose result is worth rendering in the interactive console widget —
// reviews (screenshots), diffs/status, workspace state, and the repo list.
// Every other tool returns a plain text/structured result with NO widget, so
// the panel does not eat space on high-frequency, low-visual calls (file reads,
// shell exec, logs, commits, etc.). Only tools in this set carry the
// resourceUri / outputTemplate that makes the host mount the console.
const WIDGET_TOOLS = new Set([
  'forge_review', 'forge_review_capture',
  'forge_git_diff', 'forge_git_outgoing_diff', 'forge_git_status',
  'forge_workspace_create', 'forge_workspace_get', 'forge_repository_list'
]);

/** Whether a tool's result renders the interactive console widget. */
export function showsWidget(name: string): boolean {
  return WIDGET_TOOLS.has(name);
}

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

// Optional output schema plumbing. ForgeToolDefinition does not yet carry an
// output schema, so this reads a best-effort optional field. When
// @forge/mcp-core adds `outputSchema?: ZodRawShape` to definitions it flows
// through here automatically (see report).
type WithOutputSchema = { outputSchema?: ZodRawShape };

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

export function registerForgeToolsV1(server: McpServer, handlers: ForgeToolHandlers): void {
  for (const definition of forgeTools) {
    const status = TOOL_INVOCATION_STATUS[definition.name];
    const outputSchema = (definition as WithOutputSchema).outputSchema;
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        annotations: toolAnnotations(definition.name, definition.sideEffect),
        _meta: {
          ...(showsWidget(definition.name)
            ? {
                ui: { resourceUri: FORGE_CONSOLE_URI, visibility: ['model', 'app'] },
                'openai/outputTemplate': FORGE_CONSOLE_URI
              }
            : {}),
          ...(status
            ? {
                'openai/toolInvocation/invoking': status.invoking,
                'openai/toolInvocation/invoked': status.invoked
              }
            : {})
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

          const rawValue = isResponse(result) ? result.value : result;
          const { structured, meta } = splitMeta(rawValue);

          // Component-only _meta is forwarded to the widget via the result _meta,
          // merged with the per-tool ChatGPT status strings, and kept out of the
          // model-visible structuredContent.
          const resultMeta: Record<string, unknown> = {
            ...(status
              ? {
                  'openai/toolInvocation/invoking': status.invoking,
                  'openai/toolInvocation/invoked': status.invoked
                }
              : {}),
            ...(meta ?? {})
          };

          return {
            structuredContent: structured,
            // A ForgeToolResponse already carries purpose-built content (e.g.
            // image artifacts); otherwise emit a single short text summary
            // instead of JSON.stringify-ing the whole payload.
            content: isResponse(result)
              ? result.content
              : [{ type: 'text' as const, text: summarize(definition.name, structured) }],
            ...(Object.keys(resultMeta).length > 0 ? { _meta: resultMeta } : {})
          };
        } catch (error) {
          const shape = toForgeError(error).toJSON();
          // Hoist structured error details (e.g. an approval requirement's
          // { kind, action, approval_id, approval_url, expires_at }) to the top
          // level so the widget's action bar can render an Approve button —
          // the widget reads approval_url/approval_id from structuredContent,
          // not from the nested error.details.
          const details =
            shape.details && typeof shape.details === 'object'
              ? (shape.details as Record<string, unknown>)
              : {};
          const result = { error: shape, ...details };
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
