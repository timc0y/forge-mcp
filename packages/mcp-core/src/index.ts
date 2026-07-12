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
  { name: 'forge_repository_list', title: 'List authorized repositories', description: 'List GitHub repositories currently authorized through the Forge GitHub App for this account.', inputSchema: {}, sideEffect: 'none', approval: 'none' },
  { name: 'forge_url_review', title: 'Review a live URL with screenshots', description: 'Use the cheapest Forge path: capture inspected screenshot and accessibility evidence from an existing URL without starting a container. Ideal for Parallax reviews of deployed sites.', inputSchema: { url: z.string().url(), captures: z.array(z.object({ selection: z.string().min(1).max(200), path: z.string().startsWith('/'), state: z.string().min(1).max(100).default('entry') })).min(1).max(10), viewports: z.array(z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(1920), height: z.number().int().min(320).max(2160) })).min(1).max(2).default([{ id: 'phone', width: 390, height: 844 }, { id: 'desktop', width: 1440, height: 900 }]), full_page: z.boolean().default(false) }, sideEffect: 'none', approval: 'none' },
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
  { name: 'forge_git_branch_create', title: 'Create Forge branch', description: 'Create and check out a local branch under the required forge/ namespace.', inputSchema: { workspace_id: workspaceId, branch: z.string().startsWith('forge/').max(107), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_git_commit', title: 'Commit workspace changes', description: 'Stage selected repository paths and create a commit attributed to forge-mcp[bot].', inputSchema: { workspace_id: workspaceId, message: z.string().min(1).max(500), paths: z.array(z.string().min(1).max(500)).max(100).default([]), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_git_outgoing_diff', title: 'Inspect outgoing Git change', description: 'Return the exact bounded diff and hash between the base branch and current Forge branch before approval.', inputSchema: { workspace_id: workspaceId, base: z.string().min(1).max(255).default('main') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_push', title: 'Push Forge branch', description: 'Push a non-default forge/ branch through the GitHub App credential proxy. A real user approval page is required.', inputSchema: { workspace_id: workspaceId, branch: z.string().startsWith('forge/').max(107), base: z.string().min(1).max(255).default('main'), expected_diff_hash: z.string().regex(/^[a-f0-9]{64}$/), approval_id: z.string().startsWith('apr_').optional(), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_pull_request_create', title: 'Create draft pull request', description: 'Create a draft GitHub pull request for an already pushed Forge branch. A real user approval page is required.', inputSchema: { workspace_id: workspaceId, head: z.string().startsWith('forge/').max(107), base: z.string().min(1).max(255).default('main'), title: z.string().min(1).max(256), body: z.string().max(60000).default(''), approval_id: z.string().startsWith('apr_').optional() }, sideEffect: 'external', approval: 'required' },
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
