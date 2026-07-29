import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { forgeTools, type ForgeToolHandlers, type ForgeToolResponse } from '@forge/mcp-core';
import { toForgeError } from '@forge/core';
import { z, type ZodRawShape } from 'zod';

const RETRY_SAFE_MUTATIONS = new Set([
  'forge_workspace_create',
  'forge_shell',
  'forge_process_stop',
  'forge_workspace_destroy',
  'forge_deps_install',
  'forge_preview_expose'
]);

const TRUE_READS = new Set([
  'forge_access',
  'forge_history',
  'forge_capabilities',
  'forge_observer_workspaces',
  'forge_observer_workspace',
  'forge_observer_activity',
  'forge_repository_list',
  'forge_workspace_get',
  'forge_files_list',
  'forge_files_read',
  'forge_process_logs',
  'forge_process_list',
  'forge_process_wait',
  'forge_diff_metadata',
  'forge_context_get',
  'forge_operation_get',
  'forge_artifact_get',
  'forge_task_get',
  'forge_task_list',
  'forge_secret_list'
]);

// Tools that reach the open world of arbitrary external URLs (not just the
// account's own GitHub App host or a workspace-scoped preview). forge_review
// takes a caller-supplied url and fetches it directly.
const OPEN_WORLD = new Set([
  'forge_review'
]);

// Short (<=64 char) ChatGPT status strings surfaced through result/tool _meta.
interface ToolInvocationStatus { invoking: string; invoked: string }
const TOOL_INVOCATION_STATUS: Partial<Record<string, ToolInvocationStatus>> = {
  forge_review: { invoking: 'Capturing screenshots…', invoked: 'Screenshots ready' },
  forge_preview: { invoking: 'Capturing preview…', invoked: 'Preview captured' },
  forge_preview_expose: { invoking: 'Exposing preview…', invoked: 'Preview ready' },
  forge_workspace_create: { invoking: 'Creating workspace…', invoked: 'Workspace requested' },
  forge_workspace_get: { invoking: 'Checking workspace…', invoked: 'Workspace status ready' },
  forge_workspace_destroy: { invoking: 'Destroying workspace…', invoked: 'Workspace destroyed' },
  forge_files_list: { invoking: 'Listing files…', invoked: 'File list ready' },
  forge_files_read: { invoking: 'Reading files…', invoked: 'Files read' },
  forge_diff_metadata: { invoking: 'Analyzing diff…', invoked: 'Diff metadata ready' },
  forge_context_get: { invoking: 'Selecting context…', invoked: 'Context ready' },
  forge_shell: { invoking: 'Running command…', invoked: 'Command finished' },
  forge_process_logs: { invoking: 'Reading logs…', invoked: 'Logs ready' },
  forge_process_list: { invoking: 'Listing processes…', invoked: 'Process list ready' },
  forge_process_wait: { invoking: 'Waiting for process…', invoked: 'Process finished' },
  forge_process_stop: { invoking: 'Stopping process…', invoked: 'Process stopped' },
  forge_operation_get: { invoking: 'Checking operation…', invoked: 'Operation status ready' },
  forge_observer_workspaces: { invoking: 'Listing workspaces…', invoked: 'Workspace list ready' },
  forge_observer_workspace: { invoking: 'Observing workspace…', invoked: 'Workspace observer ready' },
  forge_observer_activity: { invoking: 'Loading activity…', invoked: 'Activity ready' },
  forge_merge: { invoking: 'Submitting for review…', invoked: 'Submitted for review' },
  forge_cloudflare_deploy: { invoking: 'Deploying to Cloudflare…', invoked: 'Cloudflare deploy finished' },
  forge_repository_list: { invoking: 'Listing repositories…', invoked: 'Repositories ready' },
  forge_artifact_get: { invoking: 'Fetching artifact…', invoked: 'Artifact ready' },
  forge_artifact_upload: { invoking: 'Uploading artifact…', invoked: 'Artifact uploaded' },
  forge_deps_install: { invoking: 'Installing dependencies…', invoked: 'Dependencies installed' },
  forge_task_create: { invoking: 'Creating task…', invoked: 'Task created' },
  forge_task_get: { invoking: 'Loading task…', invoked: 'Task ready' },
  forge_task_list: { invoking: 'Listing tasks…', invoked: 'Tasks ready' },
  forge_task_update: { invoking: 'Updating task…', invoked: 'Task updated' },
  forge_secret_list: { invoking: 'Listing secrets…', invoked: 'Secrets ready' },
  forge_secret_create: { invoking: 'Saving secret…', invoked: 'Secret saved' },
  forge_secret_update: { invoking: 'Updating secret…', invoked: 'Secret updated' },
  forge_secret_delete: { invoking: 'Deleting secret…', invoked: 'Secret deleted' },
  forge_secret_attach: { invoking: 'Updating secret attach…', invoked: 'Secret attach updated' }
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

/**
 * Drop fields that restate something already in the same response.
 *
 * Deliberately a named list, not a rule like "drop empty arrays": an empty
 * `failing: []` means "nothing is failing", which is not the same as absent,
 * and a general rule cannot tell those apart. Every entry here is redundant by
 * construction and is checked against its sibling before removal, so nothing
 * is dropped on the strength of its name alone.
 */
export function slimResponse(name: string, value: Record<string, unknown>): Record<string, unknown> {
  // forge_operation_get exists to report exactly this bookkeeping — "what
  // happened to op_x, was it a replay, under which key". Nothing is redundant
  // there, so it is answered in full.
  if (name === 'forge_operation_get') return value;
  const slim = { ...value };
  // Echoed verbatim from the operation it already reports, whenever the call
  // was not a replay. On a real replay the two differ and both are kept.
  if (slim.replayed === false && slim.originalOperationId === slim.operationId) {
    delete slim.originalOperationId;
  }
  // The key the agent itself sent, handed straight back.
  if (typeof slim.idempotencyKey === 'string') delete slim.idempotencyKey;
  // Echoes the request argument; the response shape already shows which form
  // came back.
  if (typeof slim.compact === 'boolean') delete slim.compact;
  return slim;
}

/**
 * Check a result against its declared output shape without failing the call.
 *
 * The shapes stay authoritative — drift is a bug and gets reported — but a
 * result that reached the agent correctly must never be destroyed on the way
 * out because a field was renamed. Returns the field paths that drifted.
 */
export function outputSchemaDrift(
  name: string,
  structured: Record<string, unknown>
): string[] | undefined {
  const shape = OUTPUT_SHAPES.get(name);
  if (!shape) return undefined;
  const parsed = z.object(shape).safeParse(structured);
  if (parsed.success) return undefined;
  return parsed.error.issues.map((issue) =>
    issue.path.length > 0 ? issue.path.join('.') : '(root)'
  );
}

const OUTPUT_SHAPES = new Map<string, ZodRawShape>(
  forgeTools.flatMap((definition) => {
    const shape = (definition as { outputSchema?: ZodRawShape }).outputSchema;
    return shape ? [[definition.name, shape] as const] : [];
  })
);

export interface ToolCallTelemetry {
  tool: string;
  durationMs: number;
  status: 'success' | 'error';
  errorCode?: string;
  errorMessage?: string;
  resultBytes?: number;
  /** The response body, so a failure can be diagnosed from what the agent saw. */
  result?: unknown;
  /**
   * Field paths where a successful result did not match its declared output
   * shape. The call still succeeded; this is how the drift gets noticed.
   */
  schemaDrift?: string[];
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
        // The declared output shapes (see mcp-core) deliberately do NOT go on
        // the wire. Registering them cost 37% of every tools/list — ~6.4k
        // tokens an agent re-reads each turn — to describe payloads it reads
        // in full when it calls the tool. Worse, the SDK turns any drift
        // between a shape and a real result into a hard -32602, so a correct
        // result becomes a broken tool. They are enforced below instead, where
        // drift is reported and the real result still reaches the agent.
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
          const { structured: full, meta } = splitMeta(rawValue);
          const structured = slimResponse(definition.name, full);

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

          const drift = outputSchemaDrift(definition.name, structured);
          onToolCall?.({
            tool: definition.name,
            durationMs: Date.now() - startedAt,
            status: 'success',
            resultBytes: JSON.stringify(response).length,
            result: response,
            ...(drift ? { schemaDrift: drift } : {}),
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
