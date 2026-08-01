import { z, type ZodRawShape } from 'zod';

const workspaceId = z.string().regex(/^ws_[0-9a-hjkmnp-tv-z]{20,32}$/).describe('Target workspace id (ws_...).');
// Kept only for forge_artifact_get. Every OTHER workspace-scoped tool below
// addresses by `workspace` instead (see addrWorkspace) — an opaque
// workspace_id is exactly what a chat client cannot be trusted to carry
// across turns: it scrolls out of context, and either every call fails or the
// model creates a second workspace and strands the first with the work in it.
// forge_artifact_get is the deliberate exception: an artifact's owning
// workspace id is handed back in the SAME response that returned the
// artifact_id (forge_review's `workspaceId`, forge_shell's
// `output_artifact_id`, forge_cloudflare_deploy's spilled log, ...), so both
// ids are already together in the model's immediate context — there is no
// multi-turn carry problem for this one to solve. It is also the only way to
// reach a forge_review url-review artifact, which has no repository or branch
// at all to be addressed by (see migrations/d1/0011_url_review_workspaces.sql).
// Deliberately a getter, not a shared constant. A single zod instance reused
// across tools is hoisted by the JSON Schema converter into a per-tool $defs
// entry plus a $ref — which costs more bytes than inlining it, in a catalog
// that is re-sent every turn. A fresh instance per call site inlines, while
// this stays the single definition of the pattern.
const wsid = () => z.string().regex(/^ws_[0-9a-hjkmnp-tv-z]{20,32}$/).describe('Workspace id from a forge_review result (no repository/branch). Otherwise use workspace.').optional();
// Replaces `workspace_id` on every workspace-scoped tool below — ONE field,
// not three. A first version split this into owner/repo/branch, but three
// optional string fields cost ~353 bytes per tool once emitted as JSON schema
// (type+minLength+maxLength+description, times three) against ~157 for one;
// across 25 tools that is ~4,900 bytes added to a catalog re-sent every turn,
// which is the exact regression this redesign exists to prevent. One string
// costs almost nothing extra over the workspace_id it replaces. Optional —
// omitting it resolves to the tenant's one open workspace; a bare branch
// resolves if unambiguous; "owner/repo#branch" pins an exact workspace. With
// none or several matching, the error names the live candidates as
// `owner/repo on branch` (never as a ws_... id — that id is exactly what a
// chat session has already lost) so it is answerable without another round
// trip. Parsing rules and the ambiguity error live in
// apps/forge-edge-gateway/src/workspace-resolve.ts (parseWorkspaceAddress /
// resolveWorkspaceId) — this is the one canonical description, used
// everywhere below rather than varied per tool.
const addrWorkspace = () => z.string().min(1).max(400).optional()
  .describe('workspace_id, "owner/repo#branch", or branch; omit for the sole open workspace.');
const revision = () => z.number().int().positive().describe('Fails if the workspace moved on past this revision.').optional();
// Repo-relative ("src/a.ts") or absolute ("/workspace/repo/src/a.ts"). Both
// resolve, because forge_edit and forge_files_list report the relative form
// and a schema that only accepted the absolute one rejected the exact string
// the previous tool had just handed over.
const repoPath = () => z.string().min(1).max(1000).describe('Repo-relative, or absolute at or under /workspace/repo.');
const idempotency = () => z.string().min(8).max(200).describe('Stable key makes a retry safe. Fresh value per distinct call.');
// Optional on every mutating tool. Supplying a stable key makes a retried call
// safe to repeat; omitting it means "no retry protection", and the server mints
// a fresh key so the call simply executes. Requiring it made the common case (a
// single call, never retried) pay for the rare one, and pushed callers into
// inventing keys they then accidentally reused — turning a real second command
// into a silent replay.
const idempotencyOptional = () => z.string().min(8).max(200).describe('Optional. Stable key makes a retry safe; omit to always execute.').optional();
const repository = z.object({ provider: z.literal('github'), owner: z.string().min(1).max(100), name: z.string().min(1).max(100) }).describe('Authorized GitHub repository to act on.');
const cwd = z.string().startsWith('/workspace').default('/workspace/repo').describe('Working directory inside the workspace; must start with /workspace.');
const secretId = z.string().regex(/^sec_[0-9a-hjkmnp-tv-z]{20,32}$/).describe('Secret id (sec_...).');
const secretProvider = z.enum(['cloudflare', 'shopify', 'generic']).default('generic');
const secretEnv = z.record(z.string(), z.string()).refine((value) => Object.keys(value).length > 0, 'At least one environment variable is required.').describe('Environment variable key-value pairs to store.');

export interface ForgeToolDefinition<TShape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: TShape;
  /**
   * Optional zod raw shape describing the tool's structured result. When
   * present the adapter threads it into registerTool so clients can validate
   * the result. It mirrors what the corresponding handler actually returns —
   * kept minimal and faithful, with optional fields where the handler may omit
   * them.
   */
  outputSchema?: ZodRawShape;
  sideEffect: 'none' | 'workspace' | 'external' | 'destructive';
  // 'deferred' — the operation needs a human decision, but never blocks on one:
  // it is staged and queued, and Forge performs it after the human approves in
  // their own time. See forge_merge.
  approval: 'none' | 'policy' | 'required' | 'deferred';
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

const taskId = z.string().regex(/^task_[0-9a-hjkmnp-tv-z]{20,32}$/).describe('Target task id (task_...).');

// ---------------------------------------------------------------------------
// Output shapes. Each is a zod raw shape faithful to the matching handler's
// return object in apps/forge-edge-gateway/src/mcp-session.ts. Kept minimal —
// only the fields the model/client benefit from, optional where the handler may
// omit them.
// ---------------------------------------------------------------------------

const repositoryRefOut = z.object({ provider: z.string(), owner: z.string(), name: z.string() });

const workspaceGetOutput = {
  id: z.string(),
  tenantId: z.string().optional(),
  projectId: z.string().optional(),
  repository: repositoryRefOut,
  requestedRef: z.string(),
  currentCommit: z.string().optional().describe('Current GitHub branch commit observed by the control plane.'),
  executorCommit: z.string().nullable().optional().describe('Commit currently materialized in the ephemeral executor, or null when no executor exists.'),
  executorSyncPending: z.boolean().optional().describe('True while the executor must advance to the current GitHub commit before execution.'),
  githubEditInProgress: z.boolean().optional().describe('True while a GitHub edit is being finalized; executor starts are blocked.'),
  currentBranch: z.string().optional(),
  state: z.string().describe('Control-plane session state. Executor allocation is lazy and may be absent until an execution tool is called.'),
  persistenceMode: z.string(),
  runtimeProfile: z.string(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  idleDeadline: z.string().optional(),
  processes: z.array(z.object({
    id: z.string(),
    command: z.string(),
    port: z.number().optional(),
    status: z.enum(['starting', 'running', 'exited', 'failed', 'stopped', 'cancelled', 'orphaned']).describe('Current process status.'),
    exitCode: z.number().optional().describe('Exit code when the process has terminated.'),
    startedAt: z.string().optional().describe('ISO timestamp when the process was started.'),
    completedAt: z.string().optional().describe('ISO timestamp when the process reached a terminal state.'),
    mutatesFilesystem: z.boolean().optional().describe('Whether the command was classified as mutating the filesystem.'),
    logArtifact: z.string().optional().describe('Artifact id of the persisted log output.')
  })).describe('Tracked workspace processes with full status.'),
  dependencyState: z.object({
    status: z.enum(['unknown', 'ready', 'missing', 'unusable']).describe('Compact dependency readiness. Prefer this over inferring from null.'),
    reason: z.string().describe('Why dependencyState has this status (e.g. not_observed, installed, install_not_visible).'),
    lockfileHash: z.string().optional(),
    installedAt: z.string().optional(),
    usable: z.boolean()
  }).describe('Dependency installation state. Always an object — never null.'),
  activeProcessIds: z.array(z.string()).optional().describe('Process ids that are still running.'),
  allowedNextActions: z.array(z.string()).optional().describe('Safe next Forge tools from this workspace state.'),
  next_step: z.string().optional().describe('Human-readable next action hint.'),
  previews: z.record(z.string(), z.object({ port: z.number(), processId: z.string(), access: z.string(), expiresAt: z.string() })).optional(),
  previewCount: z.number().optional()
} satisfies ZodRawShape;

const dependencyStateOut = z.object({
  status: z.enum(['unknown', 'ready', 'missing', 'unusable']),
  reason: z.string(),
  lockfileHash: z.string().optional(),
  installedAt: z.string().optional(),
  usable: z.boolean()
});

const processLogsOutput = {
  data: z.string().describe('New log bytes after the supplied cursor only.'),
  nextCursor: z.string().nullable().describe('Pass back as cursor for the next page; null when no more bytes remain.'),
  hasMore: z.boolean().describe('True when more log bytes remain after this page.'),
  truncated: z.boolean(),
  status: z.string().describe('Current process status.'),
  exitCode: z.number().optional().describe('Exit code when the process has terminated.'),
  completedAt: z.string().nullable().optional(),
  mutatesFilesystem: z.boolean().optional(),
  workspaceRevision: z.number(),
  allowedNextActions: z.array(z.string()).optional()
} satisfies ZodRawShape;

const diffMetadataOutput = {
  schemaVersion: z.number(),
  totalAdditions: z.number(),
  totalDeletions: z.number(),
  files: z.array(z.object({
    path: z.string(),
    changeType: z.enum(['added', 'deleted', 'modified', 'renamed']),
    additions: z.number(),
    deletions: z.number(),
    changedSymbols: z.array(z.string()),
    possibleSecret: z.boolean(),
    category: z.string()
  })),
  changedExports: z.array(z.string()),
  changedTests: z.array(z.string()),
  configChanges: z.array(z.string()),
  workerConfigChanges: z.array(z.string()),
  migrations: z.array(z.string()),
  lockfileChanges: z.array(z.string()),
  generatedChanges: z.array(z.string()),
  possibleSecretExposure: z.array(z.string()),
  riskAreas: z.array(z.string()),
  suggestedHunks: z.array(z.string()),
  hash: z.string(),
  source: z.literal('github').optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  status: z.string().optional(),
  ahead_by: z.number().optional(),
  behind_by: z.number().optional(),
  commits: z.number().optional(),
  next_step: z.string().optional()
} satisfies ZodRawShape;

const contextGetOutput = {
  schemaVersion: z.number(),
  goal: z.string(),
  results: z.array(z.object({
    path: z.string(),
    reason: z.string(),
    instructions: z.array(z.string()),
    adjacentTests: z.array(z.string()),
    packageContext: z.string().nullable(),
    warnings: z.array(z.string()),
    confidence: z.number()
  })),
  truncated: z.boolean(),
  consideredFiles: z.number(),
  next_step: z.string().optional()
} satisfies ZodRawShape;

// No sha256 here on purpose. It was returned per file and described as being
// "for a conflict-safe later edit", but no tool input has ever accepted a hash
// — the read guard is server-side, recorded when the file is read. So it cost
// 66 bytes a file and advertised a workflow an agent could not carry out.
const filesReadOutput = {
  path: z.string().optional(),
  content: z.string().optional(),
  sizeBytes: z.number().optional().describe('Bytes actually held by `content` beside it — a ranged or max_bytes-clipped read reports the slice\'s size, never the whole file\'s.'),
  truncated: z.boolean().optional(),
  source: z.literal('github').optional().describe('Repository content always comes from the selected GitHub branch.'),
  next_step: z.string().optional(),
  files: z.array(z.object({
    path: z.string(),
    content: z.string().optional(),
    sizeBytes: z.number().optional(),
    truncated: z.boolean().optional(),
    source: z.literal('github').optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    next_step: z.string().optional()
  })).optional().describe('Per-file results when several paths were requested; one failed file does not fail the batch.')
} satisfies ZodRawShape;

const evidenceCellOut = z.object({
  selection: z.unknown().optional(),
  route: z.string(),
  environment: z.string(),
  state: z.string(),
  requestedViewport: z.unknown().optional(),
  observedViewport: z.unknown().optional(),
  findingCount: z.number(),
  inspected: z.boolean()
});

const reviewOutput = {
  schemaVersion: z.number(),
  provider: z.string(),
  executionMode: z.string(),
  containerUsed: z.boolean(),
  workspaceId: z.string(),
  sourceUrl: z.string(),
  capturedAt: z.string(),
  requestedCaptures: z.number(),
  capturedCount: z.number(),
  complete: z.boolean().describe('True when every requested cell was captured.'),
  evidence: z.array(evidenceCellOut),
  failures: z.array(z.unknown()),
  skipped: z.array(z.unknown()),
  structureSummary: z.unknown().describe('Aggregate heading-structure health across all cells.'),
  limitations: z.array(z.string()),
  galleryUrl: z.string().optional().describe("A shareable page showing every screenshot from this review; give it to the human when they should look themselves."),
  inlineImageCount: z.number().describe("How many screenshots are attached to this result as images."),
  omittedImageCount: z.number().optional().describe("Captures that did not fit in the response; fetch with forge_artifact_get."),
  nextStep: z.string()
} satisfies ZodRawShape;

const reviewCaptureOutput = {
  galleryUrl: z.string().optional().describe('A shareable page showing every screenshot from this capture.'),
  inlineImageCount: z.number().optional().describe('How many screenshots are attached to this result as images.'),
  omittedImageCount: z.number().optional().describe('Captures that did not fit in the response.'),
  schemaVersion: z.number(),
  provider: z.string(),
  executionMode: z.string(),
  workspaceId: z.string(),
  repository: z.string(),
  commit: z.string().optional(),
  workspaceRevision: z.number(),
  capturedAt: z.string(),
  previewId: z.string(),
  requestedCaptures: z.number(),
  capturedCount: z.number(),
  evidence: z.array(evidenceCellOut.extend({ executedSteps: z.unknown().nullable().optional() })),
  failures: z.array(z.unknown()),
  structureSummary: z.unknown(),
  limitations: z.array(z.string()),
  nextStep: z.string()
} satisfies ZodRawShape;

const taskSummaryOutput = {
  taskId: z.string(),
  goal: z.string(),
  decisions: z.array(z.string()),
  nonGoals: z.array(z.string()),
  baseRef: z.string(),
  branch: z.string().nullable(),
  workspaceState: z.enum(['none', 'attached']),
  previewState: z.enum(['none', 'open']),
  filesRead: z.array(z.string()),
  filesChanged: z.array(z.string()),
  checks: z.array(z.object({ command: z.string(), status: z.string() })),
  evidence: z.array(z.string()),
  outstanding: z.array(z.string()),
  knownLimitations: z.array(z.string()),
  nextRecommendedAction: z.string(),
  state: z.string(),
  updatedAt: z.string()
} satisfies ZodRawShape;

const repositoryListOutput = {
  repositories: z.array(z.object({
    owner: z.string(),
    name: z.string(),
    visibility: z.string().optional(),
    default_branch: z.string().optional(),
    last_verified_at: z.unknown().optional()
  })),
  // Hoisted off the rows whenever every repository agrees, which is the normal
  // case: one install, one sync. A row keeps its own value when it differs.
  default_branch: z.string().optional(),
  last_verified_at: z.unknown().optional(),
  reason: z.string().optional().describe('Present only when the list is empty: why there are none (never_installed, revoked, stale_owner, ok).'),
  next_step: z.string().optional().describe('Present only when the list is empty: what the account owner has to do, and where.')
} satisfies ZodRawShape;

export const forgeTools = [
  // Discover
  { name: 'forge_capabilities', title: 'Capabilities', description: 'Return what this Forge session can do (workspace, Git, secrets, previews, approvals).', inputSchema: {}, sideEffect: 'none', approval: 'none' },
  { name: 'forge_observer_workspaces', title: 'Observer: list workspaces', description: 'Read-only snapshot of live workspace slots, tasks, and branch state for operator visibility. Does not mutate sandboxes.', inputSchema: {}, sideEffect: 'none', approval: 'none' },
  { name: 'forge_observer_workspace', title: 'Observer: workspace detail', description: 'Read-only observer bundle: processes, merged MCP tool trail, log tail. Same data as /app/live for one workspace.', inputSchema: { workspace: addrWorkspace() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_observer_activity', title: 'Observer: tool activity', description: 'Complete read-only trail of MCP tool calls (redacted request/response). Default returns payloads from mcp_tool_calls. Pass payloads:false for counters only; errors_only:true narrows to failures.', inputSchema: { workspace: addrWorkspace(), payloads: z.boolean().default(true), errors_only: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(40), since: z.string().datetime().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_repository_list', title: 'List repositories', description: 'List GitHub repositories authorized for this account. No container.', inputSchema: {}, outputSchema: repositoryListOutput, sideEffect: 'none', approval: 'none' },

  // Tasks (durable, container-free)
  { name: 'forge_task_create', title: 'Create task', description: 'Create a durable task (goal, decisions, non-goals). Call before opening a workspace for coherent work.', inputSchema: { repository, base_ref: z.string().min(1).max(255).default('main'), goal: z.string().min(1).max(2000), decisions: z.array(z.string().min(1).max(500)).max(40).default([]), non_goals: z.array(z.string().min(1).max(500)).max(40).default([]), likely_paths: z.array(z.string().min(1).max(500)).max(40).default([]) }, outputSchema: { task_id: z.string(), state: z.string(), revision: z.number(), container_used: z.boolean(), next_step: z.string().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_get', title: 'Get task', description: 'Get a task. mode=full (default), summary (compact resume), or resume (task + workspace + git + handoff in one call).', inputSchema: { task_id: taskId, mode: z.enum(['full', 'summary', 'resume']).default('full'), workspace: addrWorkspace(), compact: z.boolean().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_list', title: 'List tasks', description: 'List recent tasks, optionally filtered by state or query.', inputSchema: { state: z.enum(['planning','ready','coding','validating','previewing','reviewing','awaiting-approval','complete','failed','cancelled']).optional(), q: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(100).default(20) }, outputSchema: { tasks: z.array(z.object(taskSummaryOutput)), returned: z.number().int(), hint: z.string().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_update', title: 'Update task', description: 'Finish a task (outcome) and/or record a handoff for the next session.', inputSchema: { task_id: taskId, outcome: z.enum(['complete','failed','cancelled']).optional(), note: z.string().max(2000).optional(), force: z.boolean().default(false), handoff_summary: z.string().min(1).max(2000).optional(), next_steps: z.array(z.string().min(1).max(500)).max(20).optional(), key_learnings: z.array(z.string().min(1).max(500)).max(20).optional(), modified_files: z.array(z.string().min(1).max(500)).max(50).optional(), blocked_by: z.string().max(500).optional(), expected_revision: revision() }, sideEffect: 'none', approval: 'none' },

  // Workspace
  { name: 'forge_start', title: 'Start a branch', description: 'Create forge/<slug> on GitHub from base_ref (default: the repository’s own default branch) — before any workspace exists, no container. Pass the returned branch as ref to forge_workspace_create: it adopts an already-existing forge/ branch instead of cutting a new one, so the branch is on origin from the moment it exists at all. If a live workspace already covers this repository, next_step steers you to reuse it instead of creating another.', inputSchema: { owner: z.string().min(1).max(100), repo: z.string().min(1).max(100), base_ref: z.string().min(1).max(255).optional().describe('Branch to fork from. Omit to use the repository’s actual default branch, resolved from GitHub rather than assumed to be main.'), slug: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).optional().describe('Branch becomes forge/<slug>. Omit for a generated one.'), idempotency_key: idempotencyOptional() }, outputSchema: { owner: z.string(), repo: z.string(), branch: z.string(), base_ref: z.string(), base_sha: z.string(), created: z.boolean(), existing_workspaces: z.array(z.object({ workspace_id: z.string(), branch: z.string().nullable().optional(), state: z.string().nullable().optional() })).optional(), next_step: z.string() }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_workspace_create', title: 'Create workspace', description: 'Create a lightweight control-plane coding session and return workspace_id + operation_id immediately. No executor is provisioned here; the first shell, install, build, test, dev, preview, or deploy call allocates an ephemeral executor using the requested runtime/bootstrap settings. Refuses a second live workspace for the same repository — reuse owner/repo#branch instead.', inputSchema: { repository, ref: z.string().default('main'), runtime: z.enum(['node-22','node-24','python-3.13','general-purpose']).default('node-24').describe('Executor runtime to allocate lazily on the first execution call.'), persistence: z.literal('ephemeral').default('ephemeral'), bootstrap: z.boolean().default(true).describe('Run bootstrap when the executor is first allocated, not during workspace creation.'), idempotency_key: idempotencyOptional() }, outputSchema: { workspace_id: z.string(), state: z.string().describe('Control-plane session state. requested means the GitHub branch is ready and the executor has not been allocated yet.'), operation_id: z.string(), workspace_revision: z.number(), current_branch: z.string().optional(), branch_policy: z.unknown().optional(), executor_state: z.enum(['ready', 'not_loaded']).optional().describe('ready when an executor is attached; not_loaded after lazy create until the first execution tool.'), allowedNextActions: z.array(z.string()).optional().describe('Safe next Forge tools. After lazy create this includes GitHub CRUD tools, not only forge_workspace_get.'), next_step: z.string() }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_workspace_get', title: 'Get workspace', description: 'Compact workspace summary including branch_policy (must be on forge/). Defaults to compact:true for ChatGPT — pass compact:false only when you need the full dump.', inputSchema: { workspace: addrWorkspace(), compact: z.boolean().default(true) }, outputSchema: workspaceGetOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_destroy', title: 'Destroy workspace', description: 'End the control-plane session and discard any ephemeral executor state. GitHub branches and forge_edit commits are unaffected; command-created files that were not recreated with forge_edit are intentionally lost.', inputSchema: { workspace: addrWorkspace(), preserve_artifacts: z.boolean().default(true), force: z.boolean().default(false), expected_revision: revision(), idempotency_key: idempotencyOptional() }, sideEffect: 'destructive', approval: 'policy' },
  { name: 'forge_operation_get', title: 'Get operation', description: 'After a disconnect or unknown tool outcome, check whether operation op_... finished, failed, or is still active.', inputSchema: { workspace: addrWorkspace(), operation_id: z.string().startsWith('op_') }, outputSchema: { workspaceId: z.string(), operationId: z.string(), idempotencyKey: z.string(), replayed: z.boolean(), originalOperationId: z.string(), status: z.enum(['accepted', 'active', 'completed', 'failed', 'cancelled']), processId: z.string().nullable(), process: z.unknown().nullable(), dependencyState: dependencyStateOut, workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'none', approval: 'none' },
  // Files
  { name: 'forge_files_list', title: 'List files', description: 'List a bounded file tree from the selected GitHub branch. No executor is allocated and no executor filesystem is consulted. Paths come back repo-relative, which is the form forge_edit and forge_files_read take.', inputSchema: { workspace: addrWorkspace(), path: repoPath().default('/workspace/repo'), depth: z.number().int().min(1).max(20).default(4), limit: z.number().int().min(1).max(10000).default(1000) }, outputSchema: { root: z.string(), entries: z.array(z.unknown()), truncated: z.boolean(), source: z.literal('github').optional(), hint: z.string().optional(), next_step: z.string().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_read', title: 'Read files', description: 'Read one file or several directly from the selected GitHub branch without allocating an executor. The read guard that protects forge_edit is server-side; no input takes a hash back.', inputSchema: { workspace: addrWorkspace(), path: repoPath().optional(), paths: z.array(repoPath()).min(1).max(20).optional(), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional(), max_bytes: z.number().int().min(1).max(500000).default(200000), compact: z.boolean().optional() }, outputSchema: filesReadOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_edit', title: 'Edit files', description: 'Edit files. Committed straight to GitHub on your branch — no push, nothing left only in the workspace. Prefer replace: [{old,new}] and send only the fragment you are changing; Forge reads the current file and applies it. Use content for a whole new file, or content:null to delete. Returns the commit URL.', inputSchema: { workspace: addrWorkspace(), files: z.array(z.object({ path: z.string().min(1).max(1000), content: z.string().max(500000).nullable().optional(), replace: z.array(z.object({ old: z.string().min(1).max(100000), new: z.string().max(100000), all: z.boolean().optional() })).min(1).max(20).optional() })).min(1).max(50), message: z.string().min(1).max(500).optional(), idempotency_key: idempotencyOptional() }, outputSchema: { mutationOutcome: z.string(), durability: z.string(), on_remote: z.boolean(), durability_statement: z.string(), commit_sha: z.string().optional(), commit_url: z.string().optional(), branch: z.string(), paths: z.array(z.string()), rebased: z.boolean(), executor_synced: z.boolean().optional(), executor_sync_recorded: z.boolean().optional(), replayed: z.boolean().optional(), next_step: z.string() }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_diff_metadata', title: 'Diff metadata', description: 'Syntax-only metadata over the GitHub branch comparison: changed symbols, secret risk, file classification, and suggested hunks. No executor is allocated.', inputSchema: { workspace: addrWorkspace(), base: z.string().min(1).max(255).default('main') }, outputSchema: diffMetadataOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_context_get', title: 'Get context', description: 'Deterministic repo-context selection for a goal. Returns ranked file paths with reasons, adjacent tests, governing instructions, and confidence scores. Does NOT return file contents — use forge_files_read for that.', inputSchema: { workspace: addrWorkspace(), goal: z.string().min(1).max(2000), likely_paths: z.array(z.string().min(1).max(500)).max(40).default([]), max_results: z.number().int().min(1).max(100).default(12) }, outputSchema: contextGetOutput, sideEffect: 'none', approval: 'none' },

  // Shell + processes
  { name: 'forge_shell', title: 'Run command', description: 'Allocate an ephemeral executor on first use and run a command for up to 30 seconds. Set async:true for known-long work; otherwise a long-running command returns process_id. Refused while a dependency install is still running — wait that process first. Never edit repo files via shell (sed/redirects/git add/commit/push) — use forge_edit. Command-created files remain executor-only and report remote_persisted:false.', inputSchema: { workspace: addrWorkspace(), command: z.string().min(1).max(16384), cwd, timeout_ms: z.number().int().min(100).max(900000).default(30000), environment: z.record(z.string(), z.string()).default({}), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist','unrestricted_with_approval']).default('development'), output_limit_bytes: z.number().int().min(1000).max(1000000).default(200000), mode: z.enum(['read_only', 'mutating']).optional(), async: z.boolean().optional(), compact: z.boolean().default(true), expected_revision: revision(), idempotency_key: idempotencyOptional(), approval_id: z.string().startsWith('apr_').optional() }, outputSchema: { remote_persisted: z.literal(false).describe('Always false for executor commands. Use forge_edit to create a durable GitHub change.'), executor_filesystem: z.literal('ephemeral').optional(), persistence_notice: z.string().optional(), exitCode: z.number().optional(), processId: z.string().optional(), status: z.string().optional(), next_step: z.string().optional(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_process_list', title: 'List processes', description: 'List managed executor processes. Pass process_id to get one process in detail. Process filesystem effects are ephemeral and never imply a GitHub change.', inputSchema: { workspace: addrWorkspace(), process_id: z.string().startsWith('proc_').optional() }, outputSchema: { workspaceId: z.string(), processes: z.array(z.object({ id: z.string(), command: z.string(), status: z.string(), exitCode: z.number().optional(), startedAt: z.string().optional(), completedAt: z.string().optional(), mutatesFilesystem: z.boolean() })).optional(), process: z.unknown().optional(), dependencyState: dependencyStateOut.optional(), workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_process_wait', title: 'Wait for process', description: 'Observe a managed executor process for at most 30 seconds. timedOut:true is observational: call again with the same process_id instead of restarting it. Process filesystem effects remain executor-only and are never auto-committed to GitHub.', inputSchema: { workspace: addrWorkspace(), process_id: z.string().startsWith('proc_'), timeout_ms: z.number().int().min(1000).max(30000).default(30000) }, outputSchema: { workspaceId: z.string(), process: z.unknown(), dependencyState: dependencyStateOut, timedOut: z.boolean().optional(), suggestedTimeoutMs: z.number().optional(), remote_persisted: z.literal(false).describe('Always false for executor commands. Use forge_edit to create a durable GitHub change.'), finalLogCursor: z.string().nullable().optional(), workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional(), next_step: z.string().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_process_logs', title: 'Process logs', description: 'Read new log bytes after an opaque cursor. Pass nextCursor until hasMore is false.', inputSchema: { workspace: addrWorkspace(), process_id: z.string().startsWith('proc_'), cursor: z.string().optional() }, outputSchema: processLogsOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_process_stop', title: 'Stop process', description: 'Stop a managed process. force:true cancels harder (SIGTERM then SIGKILL).', inputSchema: { workspace: addrWorkspace(), process_id: z.string().startsWith('proc_'), force: z.boolean().default(false), expected_revision: revision(), idempotency_key: idempotencyOptional() }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_deps_install', title: 'Install dependencies', description: 'Allocate the ephemeral executor if needed and start one managed dependency install. Reuse its processId with bounded forge_process_wait calls; do not start a second install. Lockfile changes remain executor-only until explicitly recreated with forge_edit.', inputSchema: { workspace: addrWorkspace(), frozen_lockfile: z.boolean().default(true), allow_lockfile_update: z.boolean().default(false), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist','unrestricted_with_approval']).default('package_install'), timeout_ms: z.number().int().min(10000).max(900000).default(600000), expected_revision: revision(), idempotency_key: idempotencyOptional() }, outputSchema: { workspaceId: z.string(), started: z.boolean().optional(), success: z.boolean().optional(), status: z.string().optional(), exitCode: z.number().optional(), packageManager: z.string().optional(), installCommand: z.string().optional(), lockfileHashBefore: z.string().optional(), lockfileHashAfter: z.string().optional(), lockfileChanged: z.boolean().optional(), dependencyState: dependencyStateOut.optional(), processId: z.string().optional(), managedProcess: z.boolean().optional(), suggestedTimeoutMs: z.number().optional(), reusedActiveProcess: z.boolean().optional(), remote_persisted: z.literal(false), executor_filesystem: z.literal('ephemeral'), operationId: z.string(), workspaceRevision: z.number(), replayed: z.boolean().optional(), idempotencyKey: z.string().optional(), originalOperationId: z.string().optional(), stderr: z.string().optional(), stdout: z.string().optional(), allowedNextActions: z.array(z.string()).optional(), next_step: z.string().optional() }, sideEffect: 'workspace', approval: 'policy' },

  // Git
  { name: 'forge_pr', title: 'Pull requests', description: 'List PRs or read live readiness. Merge and close re-check the head, require human approval, and bind a supplied idempotency_key to one exact mutation.', inputSchema: { owner: z.string().min(1).max(100), repo: z.string().min(1).max(100), action: z.enum(['list', 'status', 'merge', 'close']).default('list'), number: z.number().int().positive().optional(), expected_head_sha: z.string().regex(/^[0-9a-f]{40}$/u).optional().describe('Optional concurrency guard from action:status for merge or close.'), merge_method: z.enum(['merge', 'squash', 'rebase']).default('merge'), force: z.boolean().default(false), reason: z.string().min(1).max(500).optional(), approval_id: z.string().startsWith('apr_').optional(), idempotency_key: idempotencyOptional() }, outputSchema: { repository: z.string(), pull_requests: z.array(z.object({ number: z.number().int(), title: z.string(), head: z.string(), base: z.string(), draft: z.boolean(), url: z.string() })).optional(), status: z.object({ number: z.number().int(), title: z.string(), head_sha: z.string(), mergeable: z.boolean().nullable(), mergeable_state: z.string(), state: z.string(), already_merged: z.boolean(), checks: z.object({ total: z.number().int(), passed: z.number().int(), failed: z.number().int(), pending: z.number().int(), failing: z.array(z.string()) }), review_decision: z.string().nullable(), safe_to_merge: z.boolean(), blockers: z.array(z.string()) }).optional(), merged: z.boolean().optional(), merge_sha: z.string().optional(), closed: z.boolean().optional(), replayed: z.boolean().optional(), next_step: z.string() }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_access', title: 'Repository access', description: 'Why Forge can or cannot reach a repository: which repositories this account has authorized, and for one repo whether the GitHub App is installed and what it can do. Call this when a Git operation fails with a permission error, before assuming the transport is broken.', inputSchema: { owner: z.string().min(1).max(100).optional(), repo: z.string().min(1).max(100).optional() }, outputSchema: { authorized_repositories: z.array(z.string()), checked: z.string().optional(), authorized: z.boolean().optional(), can_read: z.boolean().optional(), can_write: z.boolean().optional().describe('Proved by minting the same write-scoped token the editing path uses, not read off the repository object.'), granted_permissions: z.record(z.string(), z.string()).optional(), default_branch: z.string().optional(), reason: z.string().optional(), next_step: z.string() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_history', title: 'Commit history', description: 'Recent commits on a branch, or the history of one file. Returns sha, message, author and date \u2014 not diffs. Use it to see how a file got to its current state without cloning anything.', inputSchema: { owner: z.string().min(1).max(100), repo: z.string().min(1).max(100), path: z.string().min(1).max(1000).optional(), ref: z.string().min(1).max(255).optional(), limit: z.number().int().min(1).max(50).default(20) }, outputSchema: { repository: z.string(), ref: z.string(), path: z.string().optional(), commits: z.array(z.object({ sha: z.string(), message: z.string(), author: z.string(), date: z.string(), url: z.string() })), returned: z.number().int(), next_step: z.string() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_branches', title: 'List or delete branches', description: 'List branches with proved merge state, or delete one. Live-workspace and default branches are always refused; unmerged deletion needs force plus reason. Large lists report truncation.', inputSchema: { owner: z.string().min(1).max(100), repo: z.string().min(1).max(100), action: z.enum(['list', 'delete']).default('list'), branch: z.string().min(1).max(255).optional(), expected_sha: z.string().regex(/^[0-9a-f]{40}$/u).optional().describe('Optional concurrency guard from action:list. Refuse deletion if the branch tip changed.'), merged_only: z.boolean().default(false), force: z.boolean().default(false), reason: z.string().min(1).max(500).optional(), idempotency_key: idempotencyOptional() }, outputSchema: { repository: z.string(), default_branch: z.string(), branches: z.array(z.object({ name: z.string(), sha: z.string(), merged: z.boolean(), is_default: z.boolean() })).optional(), truncated: z.boolean().optional(), deleted: z.array(z.string()).optional(), already_absent: z.array(z.string()).optional(), refused: z.array(z.object({ branch: z.string(), reason: z.string() })).optional(), next_step: z.string() }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_merge', title: 'Merge for review', description: 'Ask the human to merge your work. Opens a pull request from your branch and returns one approval link — echo the link, do not invent URLs. Your branch is already on GitHub; nothing is pushed here. Do not call again while the same submission is pending.', inputSchema: { workspace: addrWorkspace(), pr_base: z.string().min(1).max(255).default('main'), base: z.string().min(1).max(255).optional(), title: z.string().min(1).max(256).optional(), body: z.string().max(60000).default(''), task_id: taskId.optional(), idempotency_key: idempotencyOptional() }, outputSchema: { submitted: z.boolean(), replayed: z.boolean().optional(), submission_receipt: z.object({ branch: z.string(), remote_sha: z.string().optional(), staged_ref: z.string(), approval_id: z.string(), approval_url: z.string(), files_changed: z.number().int(), feature_branch_on_origin: z.boolean() }), next_step: z.string() }, sideEffect: 'external', approval: 'deferred' },
  { name: 'forge_cloudflare_deploy', title: 'Deploy to Cloudflare', description: 'Run approved Wrangler deploy as a managed process. idempotency_key is required: slow runs return process_id, then the same key reopens that process for a verified receipt.', inputSchema: { workspace: addrWorkspace(), command: z.string().min(1).max(2000).default('npx wrangler deploy'), cwd, expected_url: z.string().url().optional(), include_output: z.boolean().default(false), approval_id: z.string().startsWith('apr_').optional(), idempotency_key: idempotency() }, outputSchema: { deployed: z.boolean(), accepted: z.boolean(), process_id: z.string(), approval_id: z.string().optional(), deploy_receipt: z.object({ account_id: z.string(), worker_name: z.string().nullable(), verified_url: z.string().nullable(), http_status: z.number().int().nullable(), command: z.string() }).optional(), output_artifact_id: z.string().optional(), next_step: z.string() }, sideEffect: 'external', approval: 'required' },

  // Review / preview
  { name: 'forge_review', title: 'Review URL', description: 'Screenshot a public URL and return images within a 40s capture budget.', inputSchema: { url: z.string().url(), captures: z.array(z.object({ path: z.string().startsWith('/'), state: z.string().min(1).max(100).default('entry'), selection: z.string().min(1).max(200).optional() })).min(1).max(10).default([{ path: '/', state: 'entry' }]), viewports: z.array(z.union([z.enum(['phone','tablet','desktop']), z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(1920), height: z.number().int().min(320).max(2160) })])).min(1).max(3).default(['phone','desktop']), full_page: z.boolean().default(false), time_budget_ms: z.number().int().min(10000).max(40000).default(40000) }, outputSchema: reviewOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_preview_expose', title: 'Expose preview', description: 'Expose a running process through a short-lived Forge preview URL. Private by default; public access needs approval.', inputSchema: { workspace: addrWorkspace(), process_id: z.string().startsWith('proc_'), port: z.number().int().min(1024).max(65535), access: z.enum(['private','tenant','share-link','public']).default('private'), ttl_seconds: z.number().int().min(60).max(86400).default(3600), expected_revision: revision(), idempotency_key: idempotencyOptional() }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_preview', title: 'Preview capture', description: 'Screenshot a workspace app. Omit preview_id to start/expose its server; optional steps drive interactions. Refused while a dependency install is still running — forge_deps_install → forge_process_wait first.', inputSchema: { workspace: addrWorkspace(), preview_id: z.string().startsWith('prv_').optional(), preview_wait_ms: z.number().int().min(5000).max(30000).default(30000), captures: z.array(z.object({ route: z.string().startsWith('/'), state: z.string().min(1).max(100).default('entry'), selection: z.string().min(1).max(200).optional(), steps: z.array(z.object({ kind: z.enum(['navigate','click','fill','press','wait_for_selector','wait_for_text','wait','reload']), selector: z.string().min(1).max(1000).optional(), value: z.string().max(10000).optional(), key: z.string().min(1).max(40).optional(), text: z.string().min(1).max(1000).optional(), path: z.string().startsWith('/').optional(), timeout_ms: z.number().int().min(100).max(30000).optional() })).min(1).max(20).optional() })).min(1).max(20), viewports: z.array(z.union([z.enum(['phone','tablet','desktop']), z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(2160) })])).min(1).max(4).default(['phone','desktop']) }, outputSchema: reviewCaptureOutput, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_artifact_get', title: 'Get artifact', description: 'Fetch a stored artifact (images returned as MCP image content). workspace for a workspace artifact; workspace_id for a forge_review screenshot (it has no repository/branch).', inputSchema: { workspace_id: wsid(), workspace: addrWorkspace(), artifact_id: z.string().startsWith('art_'), max_bytes: z.number().int().min(1).max(4000000).default(2500000) }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_artifact_upload', title: 'Upload artifact', description: 'Upload a binary file as a stored artifact. Pass base64-encoded content. Returns artifact id for later retrieval.', inputSchema: { workspace: addrWorkspace(), filename: z.string().min(1).max(200), content_base64: z.string().min(1), content_type: z.string().min(1).max(100).default('application/octet-stream'), metadata: z.record(z.string(), z.string().max(200)).default({}) }, sideEffect: 'workspace', approval: 'none' },

  // Secrets
  { name: 'forge_secret_list', title: 'List secrets', description: 'List stored secrets (labels, providers, env var names). Values never returned.', inputSchema: {}, sideEffect: 'none', approval: 'none' },
  { name: 'forge_secret_create', title: 'Create secret', description: 'Store env vars as a labeled secret. Encrypted at rest; values never returned.', inputSchema: { label: z.string().min(1).max(100), provider: secretProvider, env: secretEnv }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_secret_update', title: 'Update secret', description: 'Update label, provider, or env vars.', inputSchema: { secret_id: secretId, label: z.string().min(1).max(100).optional(), provider: secretProvider.optional(), env: secretEnv.optional() }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_secret_delete', title: 'Delete secret', description: 'Permanently delete a secret and detach it from workspaces.', inputSchema: { secret_id: secretId }, sideEffect: 'destructive', approval: 'none' },
  { name: 'forge_secret_attach', title: 'Attach or detach secret', description: 'Attach (default) or detach (attached:false) a secret on a workspace. Attach requires human approval.', inputSchema: { secret_id: secretId, workspace: addrWorkspace(), attached: z.boolean().default(true), approval_id: z.string().startsWith('apr_').optional() }, sideEffect: 'external', approval: 'required' }
] as const satisfies readonly ForgeToolDefinition[];

export type ForgeToolName = typeof forgeTools[number]['name'];
export type ForgeToolHandler = (input: Record<string, unknown>) => Promise<Record<string, unknown> | ForgeToolResponse>;
export type ForgeToolHandlers = { [K in ForgeToolName]: ForgeToolHandler };

/** Runtime check that every advertised tool has a handler. */
export function assertForgeToolHandlers(handlers: Partial<Record<string, ForgeToolHandler>>): ForgeToolHandlers {
  const missing = forgeTools.filter((tool) => typeof handlers[tool.name] !== 'function').map((tool) => tool.name);
  if (missing.length > 0) {
    throw new Error(`Missing Forge tool handlers: ${missing.join(', ')}`);
  }
  return handlers as ForgeToolHandlers;
}

export interface ForgeMcpAdapter {
  registerTool(definition: ForgeToolDefinition, handler: ForgeToolHandler): void;
  connect(request: Request, context: { subject: string; tenantId: string }): Promise<Response>;
}

export {
  AGENT_OUTPUT_SPILL_BYTES,
  AGENT_OUTPUT_TAIL_BYTES,
  filterUnifiedDiff,
  tailBytes,
  utf8Bytes
} from './agent-output';
