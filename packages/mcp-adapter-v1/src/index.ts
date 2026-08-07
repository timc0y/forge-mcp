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
  'forge_secret_list',
  'forge_secret_accounts',
  'forge_deploy_profiles',
  'forge_deploy_profile_plan'
]);

// Open world tools reaching arbitrary external URLs directly (not just GitHub App host or workspace-scoped previews).
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
  forge_deploy_profiles: { invoking: 'Listing deploy profiles…', invoked: 'Deploy profiles ready' },
  forge_deploy_profile_plan: { invoking: 'Planning deploy profile…', invoked: 'Deploy profile planned' },
  forge_deploy_profile_approve: { invoking: 'Approving deploy profile…', invoked: 'Deploy profile approved' },
  forge_deploy: { invoking: 'Deploying…', invoked: 'Deploy finished' },
  forge_repository_list: { invoking: 'Listing repositories…', invoked: 'Repositories ready' },
  forge_artifact_get: { invoking: 'Fetching artifact…', invoked: 'Artifact ready' },
  forge_artifact_upload: { invoking: 'Uploading artifact…', invoked: 'Artifact uploaded' },
  forge_deps_install: { invoking: 'Installing dependencies…', invoked: 'Dependencies installed' },
  forge_task_create: { invoking: 'Creating task…', invoked: 'Task created' },
  forge_task_get: { invoking: 'Loading task…', invoked: 'Task ready' },
  forge_task_list: { invoking: 'Listing tasks…', invoked: 'Tasks ready' },
  forge_task_update: { invoking: 'Updating task…', invoked: 'Task updated' },
  forge_secret_list: { invoking: 'Listing secrets…', invoked: 'Secrets ready' },
  forge_secret_accounts: { invoking: 'Listing provider accounts…', invoked: 'Accounts ready' },
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
 * Lift component-only `_meta` off handler returned value.
 *
 * SHARED DATA CONTRACT: handlers return `{ ...structuredFields, _meta }`.
 * Adapter strips `_meta` from model-visible `structuredContent`, attaching it to MCP result `_meta` for host-only status forwarding. Handlers emit ChatGPT tool-invocation status via adapter; bulk payloads (images) travel as MCP content.
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
 * Drop fields restating existing response data.
 *
 * Deliberately explicit named list. Empty `failing: []` differs from absent; general rules cannot distinguish. Every entry is redundant by construction and checked against siblings before removal.
 */
export function slimResponse(name: string, value: Record<string, unknown>): Record<string, unknown> {
  // forge_operation_get reports exact bookkeeping (replay status/keys). Answered in full.
  if (name === 'forge_operation_get') return value;
  const slim = { ...value };
  // Echoed verbatim from reported operation for non-replays. Kept if differ on real replays.
  if (slim.replayed === false && slim.originalOperationId === slim.operationId) {
    delete slim.originalOperationId;
  }
  // Agent's idempotencyKey, returned directly.
  if (typeof slim.idempotencyKey === 'string') delete slim.idempotencyKey;
  // Echoes request arg; response shape indicates form.
  if (typeof slim.compact === 'boolean') delete slim.compact;
  return slim;
}

/**
 * Check result against declared output shape without failing call.
 *
 * Shapes remain authoritative (drift reported as bugs). Results reaching agent correctly are preserved despite renamed fields. Returns drifted field paths.
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
        // Declared output shapes intentionally omitted from wire payload to save ~6.4k tokens per turn. SDK drift validation (-32602) bypassed to avoid breaking tools; drift reported downstream while results reach agent.
        annotations: toolAnnotations(definition.name, definition.sideEffect),
        // Omit `ui`/`openai/outputTemplate`: Forge renders results as host plain text/structured output. Hosted approval page (/approvals/:id) is the only Forge UI.
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

          // Optional handler `_meta` attaches alongside ChatGPT status strings, omitted from model-visible structuredContent.
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
            // ForgeToolResponse carries purpose-built content (images); otherwise emit short text summary instead of full payload stringification.
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
          // Hoist structured error details (e.g. approval requirements) to top level. Allows model to read approval_url directly from structuredContent.
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
