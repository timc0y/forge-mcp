import { z, type ZodRawShape } from 'zod';

const workspaceId = z.string().regex(/^ws_[0-9a-hjkmnp-tv-z]{20,32}$/);
const revision = z.number().int().positive().optional();
const idempotency = z.string().min(8).max(200);
const repository = z.object({ provider: z.literal('github'), owner: z.string().min(1).max(100), name: z.string().min(1).max(100) });
const cwd = z.string().startsWith('/workspace').default('/workspace/repo');

export interface ForgeToolDefinition<TShape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: TShape;
  sideEffect: 'none' | 'workspace' | 'external' | 'destructive';
  approval: 'none' | 'policy' | 'required';
}

export type ForgeMcpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ForgeToolResponse {
  kind: 'forge_tool_response';
  value: Record<string, unknown>;
  content: ForgeMcpContent[];
}

export function forgeToolResponse(
  value: Record<string, unknown>,
  content: ForgeMcpContent[]
): ForgeToolResponse {
  return { kind: 'forge_tool_response', value, content };
}

export const forgeTools = [
  { name: 'forge_workspace_create', title: 'Create Forge workspace', description: 'Create an isolated workspace from an authorized repository. Returns immediately with the current lifecycle state and revision.', inputSchema: { repository, ref: z.string().default('main'), runtime: z.enum(['node-22','node-24','python-3.13','general-purpose']).default('node-22'), persistence: z.enum(['ephemeral','snapshot_on_idle','persistent']).default('snapshot_on_idle'), bootstrap: z.boolean().default(true), start_preview: z.boolean().default(false), idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_workspace_get', title: 'Get Forge workspace', description: 'Return lifecycle, repository, revision, processes, previews, snapshot and outstanding state for one workspace.', inputSchema: { workspace_id: workspaceId }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_tree', title: 'List workspace files', description: 'Return a bounded, Git-aware file tree rooted inside /workspace.', inputSchema: { workspace_id: workspaceId, path: z.string().startsWith('/workspace').default('/workspace/repo'), depth: z.number().int().min(1).max(20).default(4), limit: z.number().int().min(1).max(10000).default(1000) }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_read', title: 'Read workspace file', description: 'Read a bounded text range with a content hash for conflict-safe edits.', inputSchema: { workspace_id: workspaceId, path: z.string().startsWith('/workspace'), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional(), max_bytes: z.number().int().min(1).max(500000).default(200000) }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_patch', title: 'Apply file patch', description: 'Apply a unified diff inside the repository. Requires an idempotency key and optional expected workspace revision.', inputSchema: { workspace_id: workspaceId, patch: z.string().min(1).max(1000000), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_shell_exec', title: 'Execute bounded command', description: 'Execute a foreground command in an explicit directory with timeout, output and network-policy bounds.', inputSchema: { workspace_id: workspaceId, command: z.string().min(1).max(16384), cwd, timeout_ms: z.number().int().min(100).max(900000).default(300000), environment: z.record(z.string(), z.string()).default({}), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist','unrestricted_with_approval']).default('development'), output_limit_bytes: z.number().int().min(1000).max(1000000).default(200000), expected_revision: revision, idempotency_key: idempotency, approved: z.boolean().default(false) }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_process_start', title: 'Start background process', description: 'Start a long-running process such as a development server and return a Forge process identifier immediately.', inputSchema: { workspace_id: workspaceId, command: z.string().min(1).max(16384), cwd, environment: z.record(z.string(), z.string()).default({}), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist']).default('development'), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_process_logs', title: 'Read process logs', description: 'Read a bounded process-log page using an opaque cursor.', inputSchema: { workspace_id: workspaceId, process_id: z.string().startsWith('proc_'), cursor: z.string().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_status', title: 'Read Git status', description: 'Return structured working-tree and branch status for the workspace repository.', inputSchema: { workspace_id: workspaceId }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_diff', title: 'Read Git diff', description: 'Return a bounded unified diff for the working tree or staged changes.', inputSchema: { workspace_id: workspaceId, staged: z.boolean().default(false) }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_preview_expose', title: 'Expose private preview', description: 'Expose a running process through a short-lived Forge preview capability. Private is the default; public requires approval.', inputSchema: { workspace_id: workspaceId, process_id: z.string().startsWith('proc_'), port: z.number().int().min(1024).max(65535), access: z.enum(['private','tenant','share-link','public']).default('private'), ttl_seconds: z.number().int().min(60).max(86400).default(3600), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_review_capture', title: 'Capture Parallax review evidence', description: 'Capture a versioned Parallax evidence packet for bounded selections, routes, states and viewports. Use forge_artifact_get to inspect each stored screenshot image.', inputSchema: { workspace_id: workspaceId, preview_id: z.string().startsWith('prv_'), captures: z.array(z.object({ selection: z.string().min(1).max(200), route: z.string().startsWith('/'), state: z.string().min(1).max(100).default('entry') })).min(1).max(20), viewports: z.array(z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(2160) })).min(1).max(4) }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_browser_screenshot', title: 'Capture browser screenshot', description: 'Capture browser evidence from a Forge preview and persist it as an artifact bound to workspace revision and viewport.', inputSchema: { workspace_id: workspaceId, preview_id: z.string().startsWith('prv_'), path: z.string().startsWith('/').default('/'), viewport: z.object({ width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(2160) }), full_page: z.boolean().default(true) }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_browser_accessibility_tree', title: 'Read browser accessibility tree', description: 'Capture the bounded accessibility tree for a Forge preview route at a selected viewport.', inputSchema: { workspace_id: workspaceId, preview_id: z.string().startsWith('prv_'), path: z.string().startsWith('/').default('/'), viewport: z.object({ width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(2160) }) }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_artifact_get', title: 'Get browser artifact', description: 'Return a stored Forge artifact to the MCP client. Image artifacts are returned as MCP image content for direct model inspection.', inputSchema: { workspace_id: workspaceId, artifact_id: z.string().startsWith('art_'), max_bytes: z.number().int().min(1).max(4000000).default(2500000) }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_destroy', title: 'Destroy Forge workspace', description: 'Revoke previews and capabilities, stop processes, destroy the sandbox and mark the workspace destroyed.', inputSchema: { workspace_id: workspaceId, preserve_artifacts: z.boolean().default(true), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'destructive', approval: 'policy' }
] as const satisfies readonly ForgeToolDefinition[];

export type ForgeToolName = typeof forgeTools[number]['name'];
export type ForgeToolHandler = (input: Record<string, unknown>) => Promise<Record<string, unknown> | ForgeToolResponse>;
export type ForgeToolHandlers = Record<ForgeToolName, ForgeToolHandler>;

export interface ForgeMcpAdapter {
  registerTool(definition: ForgeToolDefinition, handler: ForgeToolHandler): void;
  connect(request: Request, context: { subject: string; tenantId: string }): Promise<Response>;
}
