import { z, type ZodRawShape } from 'zod';

const workspaceId = z.string().regex(/^ws_[0-9a-hjkmnp-tv-z]{20,32}$/).describe('Target workspace id (ws_...).');
const revision = z.number().int().positive().optional().describe('Optimistic-concurrency guard: the revision you expect; the call fails if the workspace or task has moved on.');
const idempotency = z.string().min(8).max(200).describe('Unique key that makes this mutation safe to retry; use a fresh value per distinct call.');
const repository = z.object({ provider: z.literal('github'), owner: z.string().min(1).max(100), name: z.string().min(1).max(100) }).describe('Authorized GitHub repository to act on.');
const cwd = z.string().startsWith('/workspace').default('/workspace/repo').describe('Working directory inside the workspace; must start with /workspace.');

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
  currentCommit: z.string().optional(),
  currentBranch: z.string().optional(),
  hasUnpushedWork: z.boolean().optional().describe('True once local work exists that has not been pushed.'),
  dataLoss: z.object({ at: z.string(), detail: z.string() }).optional().describe('Set when a checkout recovery could only re-clone from the remote and had to discard local-only commits or edits that were never pushed.'),
  state: z.string().describe('Lifecycle state: requested, provisioning, ready, failed or destroyed.'),
  persistenceMode: z.string(),
  runtimeProfile: z.string(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  idleDeadline: z.string().optional(),
  // Only id/command/port are actually tracked per background process — see
  // WorkspaceRuntimeRecord.processes in @forge/application. Previously
  // declared providerProcessId/cwd/status/pid too, none of which were ever
  // populated, which combined with the dict-vs-array mismatch below meant
  // this tool failed output validation on ANY client that enforces
  // outputSchema strictly, for any workspace with a tracked process.
  processes: z.array(z.object({ id: z.string(), command: z.string(), port: z.number().optional() })),
  previews: z.record(z.string(), z.object({ port: z.number(), processId: z.string(), access: z.string(), expiresAt: z.string() }))
} satisfies ZodRawShape;

const execResultOutput = {
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number(),
  artifactRefs: z.array(z.string())
} satisfies ZodRawShape;

const gitStatusOutput = {
  raw: z.string().describe('Raw `git status --porcelain=v2 --branch` output.'),
  clean: z.boolean().describe('True when the working tree has no changes.'),
  branch: z.string().describe('Currently checked-out branch.'),
  hasUnpushedWork: z.boolean().describe('True once local commits/edits exist that have not been pushed.'),
  dataLoss: z.object({ at: z.string(), detail: z.string() }).optional().describe('Set when a checkout recovery could only re-clone from the remote and had to discard local-only work.')
} satisfies ZodRawShape;

const outgoingDiffOutput = {
  diff: z.string(),
  diffHash: z.string().describe('Stable hash of the diff; pass it back as expected_diff_hash on push.'),
  branch: z.string().optional(),
  base: z.string()
} satisfies ZodRawShape;

const filesReadOutput = {
  path: z.string().optional(),
  content: z.string().optional(),
  sha256: z.string().optional().describe('Content hash of the file, for a conflict-safe later edit.'),
  sizeBytes: z.number().optional(),
  truncated: z.boolean().optional(),
  files: z.array(z.object({
    path: z.string(),
    content: z.string().optional(),
    sha256: z.string().optional(),
    sizeBytes: z.number().optional(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
    message: z.string().optional()
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
  inlineImageCount: z.number(),
  nextStep: z.string()
} satisfies ZodRawShape;

const reviewCaptureOutput = {
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

const taskGetOutput = {
  id: z.string(),
  tenantId: z.string(),
  projectId: z.string(),
  repository: repositoryRefOut,
  baseRef: z.string(),
  goal: z.string(),
  decisions: z.array(z.string()),
  nonGoals: z.array(z.string()),
  likelyPaths: z.array(z.string()),
  filesRead: z.array(z.object({ path: z.string(), sha: z.string().optional(), readAt: z.string().optional() })),
  branch: z.string().optional(),
  workspaceId: z.string().optional(),
  processIds: z.array(z.string()),
  previewId: z.string().optional(),
  browserSessionIds: z.array(z.string()),
  changedFiles: z.array(z.string()),
  checks: z.array(z.object({ command: z.string(), cwd: z.string().optional(), status: z.string(), logArtifactId: z.string().optional(), ranAt: z.string().optional() })),
  evidenceIds: z.array(z.string()),
  latestDiffHash: z.string().optional(),
  state: z.string(),
  outstanding: z.array(z.string()),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string()
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
    installation_id: z.unknown().optional(),
    last_verified_at: z.unknown().optional()
  }))
} satisfies ZodRawShape;

const diffMetadataOutput = {
  schemaVersion: z.number(),
  files: z.array(z.object({
    path: z.string(),
    changeType: z.string(),
    additions: z.number(),
    deletions: z.number(),
    changedSymbols: z.array(z.string()),
    possibleSecret: z.boolean(),
    facts: z.unknown().optional()
  })),
  totalAdditions: z.number(),
  totalDeletions: z.number(),
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
  diffHash: z.string(),
  base: z.string(),
  branch: z.string().optional(),
  suggestedChecks: z.array(z.string()),
  rawDiffAvailableVia: z.string(),
  note: z.string()
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
  truncated: z.boolean().describe('True when max_results clipped the ranking.'),
  consideredFiles: z.number()
} satisfies ZodRawShape;

export const forgeTools = [
  { name: 'forge_repository_list', title: 'List authorized repositories', description: 'List the GitHub repositories authorized for this account through the Forge GitHub App. Container-free — use it to pick a repository before starting a task or workspace.', inputSchema: {}, outputSchema: repositoryListOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_start', title: 'Start a task', description: 'Create a durable task record that survives MCP reconnects, context compression and container sleep. Container-free — start a task first for any coherent piece of work, then attach one workspace later only when you need to run or edit code.', inputSchema: { repository, base_ref: z.string().min(1).max(255).default('main').describe('The branch or ref the task branches from.'), goal: z.string().min(1).max(2000).describe('What this task should achieve.'), decisions: z.array(z.string().min(1).max(500)).max(40).default([]).describe('Durable decisions that must survive context compression.'), non_goals: z.array(z.string().min(1).max(500)).max(40).default([]).describe('Things this task deliberately will not do.'), likely_paths: z.array(z.string().min(1).max(500)).max(40).default([]).describe('Files or directories the work is expected to touch.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_get', title: 'Get a task', description: 'Get the full task record: branch, workspace, previews, files read and changed, checks and evidence ids. Read-only and container-free.', inputSchema: { task_id: taskId }, outputSchema: taskGetOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_summary', title: 'Summarize a task', description: 'Get a compact resume summary for a task — goal, decisions, non-goals, state, files, checks, evidence, outstanding work and the next recommended action — so a fresh turn can continue without replaying the session. Excludes source, logs, diffs and secrets. Container-free.', inputSchema: { task_id: taskId }, outputSchema: taskSummaryOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_list', title: 'List tasks', description: 'List recent tasks for the account, most recently updated first, optionally filtered by state or a free-text query. Container-free.', inputSchema: { state: z.enum(['planning','ready','coding','validating','previewing','reviewing','awaiting-approval','complete','failed','cancelled']).optional().describe('Only return tasks in this state.'), q: z.string().min(1).max(200).optional().describe('Free-text filter matched against the goal, repository, and task details (changed files, decisions, outstanding work).'), limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of tasks to return.') }, outputSchema: { tasks: z.array(z.object(taskSummaryOutput)), returned: z.number().int().describe('How many tasks were returned.'), hint: z.string().optional().describe('Present only when the limit clipped the results.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_finish', title: 'Finish a task', description: 'Move a task to a terminal state (complete, failed or cancelled). Container-free. Finishing as \'complete\' is refused when failed/partial checks, unrecorded checks, unpushed changed files or outstanding items are on record — pass force with a note explaining what remains unverified to override.', inputSchema: { task_id: taskId, outcome: z.enum(['complete','failed','cancelled']).describe('The terminal state to move the task to.'), note: z.string().max(2000).optional().describe('Optional closing note added to the task. Required when force is true.'), force: z.boolean().default(false).describe('Override the completion-gap check for outcome complete. Requires note explaining what is unverified.'), expected_revision: revision }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_review', title: 'Review a deployed URL', description: 'Capture screenshot and accessibility evidence from a live public URL for a strict Parallax review, without starting a container — the cheapest review path. Each cell reports a structure-health signal (structureSummary and evidence[].accessibility.structure) that flags heading defects a screenshot hides — stacked, empty, duplicate or skipped-level headings — which must be resolved or explicitly accepted before the review passes.', inputSchema: { url: z.string().url().describe('The public URL to review.'), captures: z.array(z.object({ path: z.string().startsWith('/').describe('Route path to capture, e.g. /pricing.'), state: z.string().min(1).max(100).default('entry').describe('Label for the page state being captured.'), selection: z.string().min(1).max(200).optional().describe('Optional label for what this evidence covers.') })).min(1).max(10).describe('Routes to capture.'), viewports: z.array(z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(1920), height: z.number().int().min(320).max(2160) })).min(1).max(2).default([{ id: 'phone', width: 390, height: 844 }, { id: 'desktop', width: 1440, height: 900 }]).describe('Viewports to capture each route at.'), full_page: z.boolean().default(false).describe('Capture the full scrollable page instead of just the viewport.') }, outputSchema: reviewOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_create', title: 'Create a workspace', description: 'Create a disposable, isolated workspace (a container) from an authorized repository. Costly — create one only when you need to run or edit code; decide with the container-free task and read tools first. Returns immediately in state \'requested\'; poll forge_workspace_get until state is \'ready\' (usually under a minute) before use. idempotency_key must be unique per distinct workspace.', inputSchema: { repository, ref: z.string().default('main').describe('Branch or ref to check out.'), runtime: z.enum(['node-22','node-24','python-3.13','general-purpose']).default('node-22').describe('Runtime image for the container.'), persistence: z.literal('ephemeral').default('ephemeral').describe('Workspaces are always ephemeral.'), bootstrap: z.boolean().default(true).describe('Install dependencies on create.'), idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_workspace_get', title: 'Get a workspace', description: 'Get a workspace\'s lifecycle state, repository, revision, processes and previews. Read-only and container-free — poll it after forge_workspace_create until state is \'ready\'.', inputSchema: { workspace_id: workspaceId }, outputSchema: workspaceGetOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_context_get', title: 'Select repository context', description: 'Rank the repository files most relevant to a goal, deterministically (no embeddings, no model). Returns paths with reasons, governing instructions, adjacent tests, package context and warnings — never file contents; you decide what to read. Cheap.', inputSchema: { workspace_id: workspaceId, goal: z.string().min(1).max(2000).describe('What you are trying to do; drives the ranking.'), task_id: taskId.optional().describe('Optional task to associate the lookup with.'), root: z.string().startsWith('/workspace').default('/workspace/repo').describe('Subtree to rank within.'), max_results: z.number().int().min(1).max(100).default(12).describe('Maximum number of files to return.'), categories: z.array(z.enum(['source','tests','docs','config'])).max(4).optional().describe('Restrict results to these file categories.') }, outputSchema: contextGetOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_diff_metadata', title: 'Summarize the outgoing diff', description: 'Summarize the outgoing diff into deterministic, compact metadata: changed files, additions/deletions, changed exports, tests, config, migrations, possible secret exposure, risk areas and the files worth reading first, plus targeted verification suggestions. Syntax-only and cheap — inspect the raw diff with forge_git_outgoing_diff before any Git mutation.', inputSchema: { workspace_id: workspaceId, base: z.string().min(1).max(255).default('main').describe('Base branch to diff the current branch against.') }, outputSchema: diffMetadataOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_tree', title: 'List workspace files', description: 'List a bounded, Git-aware file tree under /workspace. Read-only; needs a ready workspace.', inputSchema: { workspace_id: workspaceId, path: z.string().startsWith('/workspace').default('/workspace/repo').describe('Directory to list.'), depth: z.number().int().min(1).max(20).default(4).describe('How many levels deep to descend.'), limit: z.number().int().min(1).max(10000).default(1000).describe('Maximum number of entries to return.') }, outputSchema: { entries: z.array(z.unknown()).describe('File-tree entries.'), truncated: z.boolean().describe('True when the listing hit the limit.'), hint: z.string().optional().describe('Present only when the listing was truncated.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_read', title: 'Read workspace files', description: 'Read one file (path) or several at once (paths) as bounded text, each with a content hash for conflict-safe edits. Reading several in one call saves round trips; start_line/end_line and max_bytes apply to each file. Needs a ready workspace.', inputSchema: { workspace_id: workspaceId, path: z.string().startsWith('/workspace').optional().describe('Single file to read.'), paths: z.array(z.string().startsWith('/workspace')).min(1).max(20).optional().describe('Several files to read in one call.'), start_line: z.number().int().positive().optional().describe('First line to include (1-based).'), end_line: z.number().int().positive().optional().describe('Last line to include (1-based).'), max_bytes: z.number().int().min(1).max(500000).default(200000).describe('Per-file byte ceiling.') }, outputSchema: filesReadOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_write', title: 'Write workspace file', description: 'Create or overwrite a whole file with its full content — simpler and more reliable than a diff for full-file changes. Pass expected_sha256 (from forge_files_read) for a conflict-safe overwrite; omit it to create a new file. Parent directories are created automatically; idempotency_key must be unique per distinct write.', inputSchema: { workspace_id: workspaceId, path: z.string().startsWith('/workspace').describe('File to create or overwrite.'), content: z.string().max(1000000).describe('Full new file content.'), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Hash the file must currently have, for a conflict-safe overwrite; omit to create.'), idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_files_patch', title: 'Apply a file patch', description: 'Apply a unified diff to the repository. Best for surgical multi-hunk edits; for whole-file rewrites prefer forge_files_write (agents often miscount diff context). idempotency_key must be unique per distinct patch.', inputSchema: { workspace_id: workspaceId, patch: z.string().min(1).max(1000000).describe('Unified diff to apply.'), idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_shell_exec', title: 'Run a command', description: 'Run a foreground command in the workspace with timeout, output and network-policy bounds. Risky commands return a real user approval URL; idempotency_key must be unique per distinct command.', inputSchema: { workspace_id: workspaceId, command: z.string().min(1).max(16384).describe('Command to run.'), cwd, timeout_ms: z.number().int().min(100).max(900000).default(300000).describe('Kill the command after this many milliseconds.'), environment: z.record(z.string(), z.string()).default({}).describe('Extra environment variables.'), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist','unrestricted_with_approval']).default('development').describe('Outbound network policy for this command.'), output_limit_bytes: z.number().int().min(1000).max(1000000).default(200000).describe('Truncate captured output past this many bytes.'), expected_revision: revision, idempotency_key: idempotency, approval_id: z.string().startsWith('apr_').optional().describe('Approval id returned by a prior blocked call.') }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_process_start', title: 'Start a background process', description: 'Start a long-running background process such as a development server and return its Forge process id immediately. idempotency_key must be unique per distinct process.', inputSchema: { workspace_id: workspaceId, command: z.string().min(1).max(16384).describe('Command to run in the background.'), cwd, environment: z.record(z.string(), z.string()).default({}).describe('Extra environment variables.'), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist']).default('development').describe('Outbound network policy for this process.'), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_process_logs', title: 'Read process logs', description: 'Read a bounded page of a background process\'s logs using an opaque cursor. Read-only.', inputSchema: { workspace_id: workspaceId, process_id: z.string().startsWith('proc_').describe('Process id from forge_process_start.'), cursor: z.string().optional().describe('Opaque cursor from a prior page.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_status', title: 'Read Git status', description: 'Get the workspace repository\'s working-tree and branch status. Read-only.', inputSchema: { workspace_id: workspaceId }, outputSchema: gitStatusOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_diff', title: 'Read Git diff', description: 'Get a bounded unified diff of the working tree, or of staged changes. Read-only.', inputSchema: { workspace_id: workspaceId, staged: z.boolean().default(false).describe('Diff staged changes instead of the working tree.') }, outputSchema: execResultOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_branch_create', title: 'Create a branch', description: 'Create and check out a local branch under the required forge/ namespace.', inputSchema: { workspace_id: workspaceId, branch: z.string().startsWith('forge/').max(107).describe('Branch name; must start with forge/.'), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_git_commit', title: 'Commit changes', description: 'Stage the given repository paths and commit them, attributed to forge-mcp[bot]. Omit message to auto-generate a conventional-commit message from the diff.', inputSchema: { workspace_id: workspaceId, message: z.string().min(1).max(500).optional().describe('Commit message; omit to auto-generate.'), paths: z.array(z.string().min(1).max(500)).max(100).default([]).describe('Paths to stage; empty stages all changes.'), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_git_outgoing_diff', title: 'Inspect the outgoing change', description: 'Get the exact bounded diff and its hash between the base branch and the current forge/ branch. Read-only — inspect this before requesting a push.', inputSchema: { workspace_id: workspaceId, base: z.string().min(1).max(255).default('main').describe('Base branch to compare against.') }, outputSchema: outgoingDiffOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_push', title: 'Push a branch', description: 'Push a non-default forge/ branch through the GitHub App credential proxy. Requires a real user approval page and the expected diff hash.', inputSchema: { workspace_id: workspaceId, branch: z.string().startsWith('forge/').max(107).describe('forge/ branch to push.'), base: z.string().min(1).max(255).default('main').describe('Base branch the push targets.'), expected_diff_hash: z.string().regex(/^[a-f0-9]{64}$/).describe('diffHash from forge_git_outgoing_diff; the push fails if the diff changed.'), approval_id: z.string().startsWith('apr_').optional().describe('Approval id from the approval page.'), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_pull_request_create', title: 'Open a draft pull request', description: 'Open a draft GitHub pull request for an already-pushed forge/ branch. Requires a real user approval page. Omit title to auto-generate the title and body from the branch diff.', inputSchema: { workspace_id: workspaceId, head: z.string().startsWith('forge/').max(107).describe('forge/ branch to open the PR from.'), base: z.string().min(1).max(255).default('main').describe('Branch to merge into.'), title: z.string().min(1).max(256).optional().describe('PR title; omit to auto-generate.'), body: z.string().max(60000).default('').describe('PR body.'), approval_id: z.string().startsWith('apr_').optional().describe('Approval id from the approval page.') }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_task_authorize_push_envelope', title: 'Pre-authorize a run of pushes', description: 'Ask a human to authorize, ONCE, a bounded envelope covering the next several forge_git_push calls to one branch — for tasks that iterate in many small commit-then-push cycles, so the human is not asked to click through every single push. A push only auto-satisfies inside the envelope while it (a) fast-forwards the same branch/base with no rewritten history, and (b) touches only paths under allowed_paths; anything else falls back to a normal, individually-approved push. Never covers forge_pull_request_create, which always needs its own approval. Requires a real user approval page, same as a push.', inputSchema: { workspace_id: workspaceId, task_id: taskId.optional().describe('Task this envelope belongs to, for traceability.'), branch: z.string().startsWith('forge/').max(107).describe('forge/ branch the envelope covers.'), base: z.string().min(1).max(255).default('main').describe('Base branch, fixed for the life of the envelope.'), allowed_paths: z.array(z.string().min(1).max(500)).min(1).max(50).optional().describe('Path prefixes the envelope covers. Omit to default to the paths in the current outgoing diff.'), ttl_minutes: z.number().int().min(5).max(480).default(120).describe('How long the envelope stays valid.'), approval_id: z.string().startsWith('apr_').optional().describe('Approval id from the approval page.') }, sideEffect: 'none', approval: 'required' },
  { name: 'forge_preview_expose', title: 'Expose a preview', description: 'Expose a running process through a short-lived Forge preview capability. Private by default; public access requires approval.', inputSchema: { workspace_id: workspaceId, process_id: z.string().startsWith('proc_').describe('Process to expose.'), port: z.number().int().min(1024).max(65535).describe('Port the process listens on.'), access: z.enum(['private','tenant','share-link','public']).default('private').describe('Who can reach the preview.'), ttl_seconds: z.number().int().min(60).max(86400).default(3600).describe('How long the preview stays open.'), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_review_capture', title: 'Capture preview review evidence', description: 'Capture screenshot and accessibility evidence from a running Forge preview — one packet across bounded routes, states and viewports. Give a capture `steps` to drive a real interaction (click/fill/press/wait) before the shot, proving multi-step flows a static screenshot cannot. Inspect each image with forge_artifact_get; this is the only preview-evidence tool.', inputSchema: { workspace_id: workspaceId, preview_id: z.string().startsWith('prv_').describe('Preview id from forge_preview_expose.'), captures: z.array(z.object({ route: z.string().startsWith('/').describe('Route path to capture, e.g. /cart.'), state: z.string().min(1).max(100).default('entry').describe('Label for the page state being captured.'), selection: z.string().min(1).max(200).optional().describe('Optional label for what this evidence covers.'), steps: z.array(z.object({ kind: z.enum(['navigate','click','fill','press','wait_for_selector','wait_for_text','wait','reload']), selector: z.string().min(1).max(1000).optional(), value: z.string().max(10000).optional(), key: z.string().min(1).max(40).optional(), text: z.string().min(1).max(1000).optional(), path: z.string().startsWith('/').optional(), timeout_ms: z.number().int().min(100).max(30000).optional() })).min(1).max(20).optional().describe('Interaction to drive before the shot.') })).min(1).max(20).describe('Routes to capture.'), viewports: z.array(z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(2160) })).min(1).max(4).describe('Viewports to capture each route at.') }, outputSchema: reviewCaptureOutput, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_artifact_get', title: 'Get an artifact', description: 'Fetch a stored Forge artifact. Image artifacts are returned as MCP image content for direct model inspection. Read-only.', inputSchema: { workspace_id: workspaceId, artifact_id: z.string().startsWith('art_').describe('Artifact id, e.g. from evidence[].screenshot.artifactId.'), max_bytes: z.number().int().min(1).max(4000000).default(2500000).describe('Maximum bytes to return.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_destroy', title: 'Destroy a workspace', description: 'Destroy a workspace: revoke previews and capabilities, stop processes and tear down the container. Do this once the task or review is complete. Refused when the repository has committed changes on a forge/ branch that were never pushed — pass force to destroy anyway and accept the loss.', inputSchema: { workspace_id: workspaceId, preserve_artifacts: z.boolean().default(true).describe('Keep captured artifacts after teardown.'), force: z.boolean().default(false).describe('Destroy even if the workspace has unpushed committed work.'), expected_revision: revision, idempotency_key: idempotency }, sideEffect: 'destructive', approval: 'policy' }
] as const satisfies readonly ForgeToolDefinition[];

export type ForgeToolName = typeof forgeTools[number]['name'];
export type ForgeToolHandler = (input: Record<string, unknown>) => Promise<Record<string, unknown> | ForgeToolResponse>;
export type ForgeToolHandlers = Record<ForgeToolName, ForgeToolHandler>;

export interface ForgeMcpAdapter {
  registerTool(definition: ForgeToolDefinition, handler: ForgeToolHandler): void;
  connect(request: Request, context: { subject: string; tenantId: string }): Promise<Response>;
}
