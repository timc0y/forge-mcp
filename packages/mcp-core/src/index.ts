import { z, type ZodRawShape } from 'zod';

const workspaceId = z.string().regex(/^ws_[0-9a-hjkmnp-tv-z]{20,32}$/).describe('Target workspace id (ws_...).');
// Optional on workspace-scoped tools. A chat client loses an opaque id across
// turns — it scrolls out of context — and then either every call fails or the
// model creates a second workspace and strands the first with the work in it.
// Omitting it resolves to the single open workspace; with none or several, the
// error says exactly what to do rather than guessing at one.
const workspaceIdOptional = workspaceId.optional().describe('Target workspace id (ws_...). Optional — omit it and Forge uses your open workspace, which is what you want whenever only one is running.');
const revision = z.number().int().positive().optional().describe('Optimistic-concurrency guard: the revision you expect; the call fails if the workspace or task has moved on.');
const idempotency = z.string().min(8).max(200).describe('Unique key that makes this mutation safe to retry; use a fresh value per distinct call.');
// Optional on every mutating tool. Supplying a stable key makes a retried call
// safe to repeat; omitting it means "no retry protection", and the server mints
// a fresh key so the call simply executes. Requiring it made the common case (a
// single call, never retried) pay for the rare one, and pushed callers into
// inventing keys they then accidentally reused — turning a real second command
// into a silent replay.
const idempotencyOptional = idempotency.optional().describe('Optional. Unique key that makes this mutation safe to retry; supply a stable value to make a retry idempotent, or omit it to always execute.');
const forgeBranch = z.string().startsWith('forge/').max(107).refine(
  (v) => !v.includes('..') && !v.endsWith('/') && !v.endsWith('.lock'),
  'Branch must not contain .., trailing /, or .lock suffix'
);
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
  // their own time. See forge_submit.
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
  processes: z.array(z.object({
    id: z.string(),
    command: z.string(),
    port: z.number().optional(),
    status: z.enum(['starting', 'running', 'exited', 'failed', 'stopped', 'cancelled', 'orphaned']).describe('Current process status.'),
    exitCode: z.number().optional().describe('Exit code when the process has terminated.'),
    startedAt: z.string().optional().describe('ISO timestamp when the process was started.'),
    completedAt: z.string().optional().describe('ISO timestamp when the process reached a terminal state.'),
    mutatesFilesystem: z.boolean().optional().describe('Whether the command was classified as mutating the filesystem.'),
    checkpointAfter: z.string().optional().describe('Snapshot id of the checkpoint captured after a successful mutating process.'),
    logArtifact: z.string().optional().describe('Artifact id of the persisted log output.')
  })).describe('Tracked workspace processes with full status.'),
  gitIntegrity: z.object({
    state: z.enum(['consistent', 'unknown', 'diverged', 'corrupted']).describe('Git integrity state.'),
    reason: z.string().describe('Why the integrity state is what it is.'),
    blockingProcessId: z.string().optional().describe('Process id blocking Git inspection, if any.'),
    gitHeadReadable: z.boolean().optional().describe('Whether .git/HEAD is readable.'),
    gitIndexReadable: z.boolean().optional().describe('Whether the Git index is readable.'),
    workingTreeReadable: z.boolean().optional().describe('Whether the working tree is readable.'),
    recommendedAction: z.string().describe('What to do next.'),
    destructiveRecoveryRequired: z.boolean().optional().describe('Whether a destructive checkpoint restore is needed.')
  }).describe('Detailed Git integrity report with reason and remediation.'),
  dependencyState: z.object({
    status: z.enum(['unknown', 'ready', 'missing', 'unusable']).describe('Compact dependency readiness. Prefer this over inferring from null.'),
    reason: z.string().describe('Why dependencyState has this status (e.g. not_observed, installed, install_not_visible).'),
    lockfileHash: z.string().optional(),
    installedAt: z.string().optional(),
    usable: z.boolean()
  }).describe('Dependency installation state. Always an object — never null.'),
  activeProcessIds: z.array(z.string()).optional().describe('Process ids that are still running.'),
  lastChecks: z.array(z.object({
    processId: z.string(),
    name: z.string(),
    exitCode: z.number().optional(),
    completedAt: z.string().optional(),
    startedAt: z.string().optional()
  })).optional().describe('Recent managed checks for resume/context.'),
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
  filesystemCommitted: z.boolean().optional().describe('True when a post-process checkpoint captured the filesystem effects.'),
  workspaceRevision: z.number(),
  allowedNextActions: z.array(z.string()).optional()
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
  hash: z.string()
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
  consideredFiles: z.number()
} satisfies ZodRawShape;

// Shared by both diff tools. A diff is the one Forge result whose size is set
// by the user's repository rather than by anything Forge controls, so it is
// returned a page of FILES at a time: `files` always lists every changed file
// (it comes from --numstat, which stays small no matter how large the content
// is), while `diff` carries the hunks for just this page.
const diffPageFields = {
  diff: z.string().describe('Unified diff for the files in `pageFiles` only — not the whole change.'),
  files: z.array(z.object({
    path: z.string(),
    additions: z.number(),
    deletions: z.number(),
    binary: z.boolean()
  })).describe('Every changed file with its line counts. Always complete, on every page.'),
  totalFiles: z.number(),
  totalAdditions: z.number(),
  totalDeletions: z.number(),
  pageFiles: z.array(z.string()).describe('Paths whose hunks are included in `diff`.'),
  cursor: z.string().optional().describe('Cursor this page started at; absent on the first page.'),
  nextCursor: z.string().nullable().describe('Pass back as `cursor` to fetch the next page. Null when this is the last page.'),
  hasMore: z.boolean().describe('True when more files remain; fetch them with `cursor: nextCursor`.'),
  truncated: z.boolean().describe('True when a single file was too large to include whole. Its remaining content is not reachable by paging — read the file with forge_files_read instead.'),
  fileListTruncated: z.boolean().optional().describe('True when even the file list had to be cut, so `files` is incomplete. Narrow with `paths`.'),
  note: z.string()
} satisfies ZodRawShape;

const outgoingDiffOutput = {
  ...diffPageFields,
  diffHash: z.string().optional().describe('Stable hash of the COMPLETE outgoing diff, not just this page; pass it back as expected_diff_hash on push. Identical on every page. Only present when scope is outgoing.'),
  branch: z.string().optional(),
  base: z.string().optional().describe('The base branch the diff was compared against. Only present when scope is outgoing.')
} satisfies ZodRawShape;

// Paging inputs shared by both diff tools.
const diffCursor = z.string().max(64).optional().describe('Opaque cursor from a prior page\'s nextCursor. Omit for the first page.');
const diffMaxBytes = z.number().int().min(2_000).max(400_000).default(64_000).describe('Approximate byte budget for this page of hunks. Lower it if results are still too large to read comfortably.');
const diffPaths = z.array(z.string().min(1).max(400)).max(200).optional().describe('Restrict the diff to these exact paths (from `files`). Use this to read one large file\'s change directly instead of paging to it.');

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
    installation_id: z.unknown().optional(),
    last_verified_at: z.unknown().optional()
  })),
  reason: z.string().optional().describe('Present only when the list is empty: why there are none (never_installed, revoked, stale_owner, ok).'),
  next_step: z.string().optional().describe('Present only when the list is empty: what the account owner has to do, and where.')
} satisfies ZodRawShape;

export const forgeTools = [
  // Discover
  { name: 'forge_capabilities', title: 'Capabilities', description: 'Return what this Forge session can do (workspace, Git, secrets, previews, approvals).', inputSchema: {}, sideEffect: 'none', approval: 'none' },
  { name: 'forge_observer_workspaces', title: 'Observer: list workspaces', description: 'Read-only snapshot of live workspace slots, tasks, and branch state for operator visibility. Does not mutate sandboxes.', inputSchema: {}, sideEffect: 'none', approval: 'none' },
  { name: 'forge_observer_workspace', title: 'Observer: workspace detail', description: 'Read-only observer bundle: processes, merged MCP tool trail, log tail. Same data as /app/live for one workspace.', inputSchema: { workspace_id: workspaceIdOptional }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_observer_activity', title: 'Observer: tool activity', description: 'Read-only D1 trail of MCP tool calls for this account (optional workspace filter).', inputSchema: { workspace_id: workspaceIdOptional, limit: z.number().int().min(1).max(200).default(40), since: z.string().datetime().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_repository_list', title: 'List repositories', description: 'List GitHub repositories authorized for this account. No container.', inputSchema: {}, outputSchema: repositoryListOutput, sideEffect: 'none', approval: 'none' },

  // Tasks (durable, container-free)
  { name: 'forge_task_create', title: 'Create task', description: 'Create a durable task (goal, decisions, non-goals). Call before opening a workspace for coherent work.', inputSchema: { repository, base_ref: z.string().min(1).max(255).default('main'), goal: z.string().min(1).max(2000), decisions: z.array(z.string().min(1).max(500)).max(40).default([]), non_goals: z.array(z.string().min(1).max(500)).max(40).default([]), likely_paths: z.array(z.string().min(1).max(500)).max(40).default([]) }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_get', title: 'Get task', description: 'Get a task. mode=full (default), summary (compact resume), or resume (task + workspace + git + handoff in one call).', inputSchema: { task_id: taskId, mode: z.enum(['full', 'summary', 'resume']).default('full'), workspace_id: workspaceIdOptional, compact: z.boolean().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_list', title: 'List tasks', description: 'List recent tasks, optionally filtered by state or query.', inputSchema: { state: z.enum(['planning','ready','coding','validating','previewing','reviewing','awaiting-approval','complete','failed','cancelled']).optional(), q: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(100).default(20) }, outputSchema: { tasks: z.array(z.object(taskSummaryOutput)), returned: z.number().int(), hint: z.string().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_update', title: 'Update task', description: 'Finish a task (outcome) and/or record a handoff for the next session.', inputSchema: { task_id: taskId, outcome: z.enum(['complete','failed','cancelled']).optional(), note: z.string().max(2000).optional(), force: z.boolean().default(false), handoff_summary: z.string().min(1).max(2000).optional(), next_steps: z.array(z.string().min(1).max(500)).max(20).optional(), key_learnings: z.array(z.string().min(1).max(500)).max(20).optional(), modified_files: z.array(z.string().min(1).max(500)).max(50).optional(), blocked_by: z.string().max(500).optional(), expected_revision: revision }, sideEffect: 'none', approval: 'none' },

  // Workspace
  { name: 'forge_workspace_create', title: 'Create workspace', description: 'Create an isolated workspace from an authorized repo. Checks out ref (default main) then auto-creates forge/<id> so agents never edit main. Waits until ready by default.', inputSchema: { repository, ref: z.string().default('main'), runtime: z.enum(['node-22','node-24','python-3.13','general-purpose']).default('node-24'), persistence: z.literal('ephemeral').default('ephemeral'), bootstrap: z.boolean().default(true), wait_for_ready: z.boolean().default(true), wait_budget_ms: z.number().int().min(5000).max(110000).default(60000), idempotency_key: idempotencyOptional }, outputSchema: { workspace_id: z.string(), state: z.string(), operation_id: z.string().optional(), workspace_revision: z.number().optional(), current_branch: z.string().optional(), branch_policy: z.unknown().optional(), next_step: z.string() }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_workspace_get', title: 'Get workspace', description: 'Compact workspace summary including branch_policy (must be on forge/). Prefer compact:true in ChatGPT.', inputSchema: { workspace_id: workspaceIdOptional, compact: z.boolean().optional() }, outputSchema: workspaceGetOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_prove', title: 'Prove workspace', description: 'Prove local Git state and verify the feature branch SHA on origin when the GitHub App is authorized.', inputSchema: { workspace_id: workspaceIdOptional }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_destroy', title: 'Destroy workspace', description: 'Tear down the workspace. Refused if unpushed forge/ commits exist unless force:true.', inputSchema: { workspace_id: workspaceIdOptional, preserve_artifacts: z.boolean().default(true), force: z.boolean().default(false), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'destructive', approval: 'policy' },
  { name: 'forge_doctor', title: 'Doctor workspace', description: 'Reconcile Git, processes, and dependency state after reconnect or weird errors. Never throws — reports gitIntegrity and recommendedAction.', inputSchema: { workspace_id: workspaceIdOptional }, outputSchema: { workspaceId: z.string(), gitIntegrity: z.object({ state: z.enum(['consistent', 'unknown', 'diverged', 'corrupted']), reason: z.string(), blockingProcessId: z.string().optional(), gitHeadReadable: z.boolean(), gitIndexReadable: z.boolean(), workingTreeReadable: z.boolean(), recommendedAction: z.string(), destructiveRecoveryRequired: z.boolean() }), healthSignals: z.object({ localGit: z.string(), remoteAgreement: z.string(), baseAgreement: z.string(), pushAuth: z.string(), previewReady: z.string(), submissionReady: z.string() }).optional(), processes: z.array(z.object({ id: z.string(), command: z.string(), status: z.string(), exitCode: z.number().optional() })), dependencyState: dependencyStateOut, trackedChangesPreserved: z.boolean(), checkpointRestored: z.boolean(), workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_operation_get', title: 'Get operation', description: 'After a disconnect or unknown tool outcome, check whether operation op_... finished, failed, or is still active.', inputSchema: { workspace_id: workspaceIdOptional, operation_id: z.string().startsWith('op_') }, outputSchema: { workspaceId: z.string(), operationId: z.string(), idempotencyKey: z.string(), replayed: z.boolean(), originalOperationId: z.string(), status: z.enum(['accepted', 'active', 'completed', 'failed', 'cancelled']), processId: z.string().nullable(), process: z.unknown().nullable(), dependencyState: dependencyStateOut, workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_snapshot', title: 'Snapshot workspace', description: 'Capture a named checkpoint of the workspace filesystem. Use before risky operations to enable rollback.', inputSchema: { workspace_id: workspaceIdOptional, name: z.string().min(1).max(200).optional() }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_workspace_restore', title: 'Restore snapshot', description: 'Roll back the workspace to a previous checkpoint. Destroys uncommitted work. Returns the restored state.', inputSchema: { workspace_id: workspaceIdOptional, snapshot_id: z.string().min(1).max(200), expected_revision: revision }, sideEffect: 'destructive', approval: 'policy' },

  // Files
  { name: 'forge_files_list', title: 'List files', description: 'List a bounded file tree under /workspace.', inputSchema: { workspace_id: workspaceIdOptional, path: z.string().startsWith('/workspace').default('/workspace/repo'), depth: z.number().int().min(1).max(20).default(4), limit: z.number().int().min(1).max(10000).default(1000) }, outputSchema: { entries: z.array(z.unknown()), truncated: z.boolean(), hint: z.string().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_read', title: 'Read files', description: 'Read one file (path) or several (paths) with content hashes for conflict-safe edits.', inputSchema: { workspace_id: workspaceIdOptional, path: z.string().startsWith('/workspace').optional(), paths: z.array(z.string().startsWith('/workspace')).min(1).max(20).optional(), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional(), max_bytes: z.number().int().min(1).max(500000).default(200000), compact: z.boolean().optional() }, outputSchema: filesReadOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_write', title: 'Write file', description: 'Create or replace one file on the current forge/ branch (auto-commits). Pass expected_sha256 for conflict-safe overwrite. Prefer forge_files_write_batch or forge_files_replace for multi-file / surgical edits.', inputSchema: { workspace_id: workspaceIdOptional, path: z.string().startsWith('/workspace/repo/').max(1000), content: z.string().max(4000000), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_files_write_batch', title: 'Write files (batch)', description: 'Write up to 20 files on the forge/ branch in one call (auto-commits). Returns path+sha receipts. Refused on main.', inputSchema: { workspace_id: workspaceIdOptional, files: z.array(z.object({ path: z.string().startsWith('/workspace/repo/').max(1000), content: z.string().max(500000), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).min(1).max(20), expected_revision: revision, idempotency_key: idempotencyOptional }, outputSchema: { written: z.number().int(), files: z.array(z.object({ path: z.string(), resultingSha256: z.string(), sizeBytes: z.number().int() })), workspaceRevision: z.number().int(), auto_commit: z.unknown().optional(), next_step: z.string() }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_files_replace', title: 'Replace in file', description: 'Search/replace inside one file on the forge/ branch (auto-commits). Prefer this over unified diffs. Fails if old_string is missing or matches multiple times unless replace_all:true.', inputSchema: { workspace_id: workspaceIdOptional, path: z.string().startsWith('/workspace/repo/').max(1000), old_string: z.string().min(1).max(200000), new_string: z.string().max(200000), replace_all: z.boolean().default(false), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), expected_revision: revision, idempotency_key: idempotencyOptional }, outputSchema: { path: z.string(), replacements: z.number().int(), resultingSha256: z.string(), auto_commit: z.unknown().optional() }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_files_patch', title: 'Patch file', description: 'Apply a unified diff on the forge/ branch (auto-commits). Optional paths= scopes hunks. Prefer forge_files_replace / write_batch when possible.', inputSchema: { workspace_id: workspaceIdOptional, patch: z.string().min(1).max(2000000), paths: z.array(z.string().min(1).max(500)).max(50).optional(), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_files_upload', title: 'Upload file', description: 'Upload a binary file to the workspace via base64. Decodes and writes to the target path. For text files, prefer forge_files_write.', inputSchema: { workspace_id: workspaceIdOptional, path: z.string().startsWith('/workspace/repo/').max(1000), content_base64: z.string().min(1), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_diff_metadata', title: 'Diff metadata', description: 'Syntax-only metadata over the outgoing diff: changed symbols, secret risk, file classification, and suggested hunks. No model, no semantics — an index into the diff, not a substitute.', inputSchema: { workspace_id: workspaceIdOptional, base: z.string().min(1).max(255).default('main') }, outputSchema: diffMetadataOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_context_get', title: 'Get context', description: 'Deterministic repo-context selection for a goal. Returns ranked file paths with reasons, adjacent tests, governing instructions, and confidence scores. Does NOT return file contents — use forge_files_read for that.', inputSchema: { workspace_id: workspaceIdOptional, goal: z.string().min(1).max(2000), likely_paths: z.array(z.string().min(1).max(500)).max(40).default([]), max_results: z.number().int().min(1).max(100).default(12) }, outputSchema: contextGetOutput, sideEffect: 'none', approval: 'none' },

  // Shell + processes
  { name: 'forge_shell', title: 'Run command', description: 'Run a command in the workspace. compact defaults true: returns exitCode + short tails; full stdout/stderr spill to output_artifact_id when >20KB (forge_artifact_get). async:true for long work. Risky commands need approval_id.', inputSchema: { workspace_id: workspaceIdOptional, command: z.string().min(1).max(16384), cwd, timeout_ms: z.number().int().min(100).max(900000).default(300000), environment: z.record(z.string(), z.string()).default({}), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist','unrestricted_with_approval']).default('development'), output_limit_bytes: z.number().int().min(1000).max(1000000).default(200000), mode: z.enum(['read_only', 'mutating']).optional(), async: z.boolean().optional(), compact: z.boolean().default(true), expected_revision: revision, idempotency_key: idempotencyOptional, approval_id: z.string().startsWith('apr_').optional() }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_process_list', title: 'List processes', description: 'List managed processes. Pass process_id to get one process in detail.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_').optional() }, outputSchema: { workspaceId: z.string(), processes: z.array(z.object({ id: z.string(), command: z.string(), status: z.string(), exitCode: z.number().optional(), startedAt: z.string().optional(), completedAt: z.string().optional(), mutatesFilesystem: z.boolean(), filesystemCommitted: z.boolean().optional() })).optional(), process: z.unknown().optional(), dependencyState: dependencyStateOut.optional(), workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_process_wait', title: 'Wait for process', description: 'Wait for a managed process to finish, or time out. Timeouts are observational (process is NOT killed) and return timedOut:true with suggestedTimeoutMs — retry with a larger timeout_ms (use >=600000 for large installs). Do not restart the command.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_'), timeout_ms: z.number().int().min(1000).max(600000).default(120000) }, outputSchema: { workspaceId: z.string(), process: z.unknown(), dependencyState: dependencyStateOut, timedOut: z.boolean().optional(), suggestedTimeoutMs: z.number().optional(), filesystemCommitted: z.boolean().optional(), finalLogCursor: z.string().nullable().optional(), workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional(), next_step: z.string().optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_process_logs', title: 'Process logs', description: 'Read new log bytes after an opaque cursor. Pass nextCursor until hasMore is false.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_'), cursor: z.string().optional() }, outputSchema: processLogsOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_process_stop', title: 'Stop process', description: 'Stop a managed process. force:true cancels harder (SIGTERM then SIGKILL).', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_'), force: z.boolean().default(false), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_deps_install', title: 'Install dependencies', description: 'Start dependency install as a managed process. If still running, returns processId — call forge_process_wait with timeout_ms >= 600000. Do not start a second install.', inputSchema: { workspace_id: workspaceIdOptional, frozen_lockfile: z.boolean().default(true), allow_lockfile_update: z.boolean().default(false), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist','unrestricted_with_approval']).default('package_install'), timeout_ms: z.number().int().min(10000).max(900000).default(600000), expected_revision: revision, idempotency_key: idempotencyOptional }, outputSchema: { workspaceId: z.string(), started: z.boolean().optional(), success: z.boolean().optional(), status: z.string().optional(), exitCode: z.number().optional(), packageManager: z.string().optional(), installCommand: z.string().optional(), lockfileHashBefore: z.string().optional(), lockfileHashAfter: z.string().optional(), lockfileChanged: z.boolean().optional(), dependencyState: dependencyStateOut.optional(), processId: z.string().optional(), managedProcess: z.boolean().optional(), filesystemCommitted: z.boolean().optional(), suggestedTimeoutMs: z.number().optional(), reusedActiveProcess: z.boolean().optional(), checkpoint: z.object({ snapshotId: z.string(), createdAt: z.string(), providerVersion: z.string() }).optional(), operationId: z.string(), workspaceRevision: z.number(), replayed: z.boolean().optional(), idempotencyKey: z.string().optional(), originalOperationId: z.string().optional(), stderr: z.string().optional(), stdout: z.string().optional(), allowedNextActions: z.array(z.string()).optional(), next_step: z.string().optional() }, sideEffect: 'workspace', approval: 'policy' },

  // Git
  { name: 'forge_git_status', title: 'Git status', description: 'Working-tree and branch status.', inputSchema: { workspace_id: workspaceIdOptional }, outputSchema: gitStatusOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_diff', title: 'Git diff', description: 'Paged diff. compact (default true): file list + totals only — no hunks (use paths/cursor with compact:false for hunks). scope=worktree|staged|outgoing.', inputSchema: { workspace_id: workspaceIdOptional, scope: z.enum(['worktree', 'staged', 'outgoing']).default('worktree'), base: z.string().min(1).max(255).default('main'), cursor: diffCursor, max_bytes: diffMaxBytes, paths: diffPaths, compact: z.boolean().default(true) }, outputSchema: outgoingDiffOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_branch', title: 'Create branch', description: 'Create and check out a local forge/<task> branch. Required before edits if create did not already place you on forge/.', inputSchema: { workspace_id: workspaceIdOptional, branch: forgeBranch, expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_git_rebase', title: 'Rebase branch', description: 'Rebase the current forge/ branch onto the latest upstream base. On conflict, aborts automatically and lists conflicted files.', inputSchema: { workspace_id: workspaceIdOptional, base: z.string().min(1).max(255).default('main') }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_git_commit', title: 'Commit', description: 'Stage paths and commit as forge-mcp[bot]. Usually unnecessary — file tools auto-commit on forge/ branches. When auto-push is enabled, push failure fails the call.', inputSchema: { workspace_id: workspaceIdOptional, message: z.string().min(1).max(500).optional(), paths: z.array(z.string().min(1).max(500)).max(100).default([]), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_git_push', title: 'Push branch', description: 'Push the forge/ branch to the remote. Requires approval. Does NOT create a PR — use forge_pull_request_create for that.', inputSchema: { workspace_id: workspaceIdOptional, branch: forgeBranch, base: z.string().min(1).max(255).default('main'), approval_id: z.string().startsWith('apr_').optional() }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_git_sync', title: 'Sync remote branch', description: 'Fetch origin and detect or reconcile divergence between workspace HEAD and the remote feature branch.', inputSchema: { workspace_id: workspaceIdOptional, action: z.enum(['detect', 'reset_to_remote', 'keep_local_and_push']).default('detect') }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_pull_request_create', title: 'Create PR', description: 'Create a draft pull request from the current forge/ branch. Requires approval. Branch must already be pushed.', inputSchema: { workspace_id: workspaceIdOptional, branch: forgeBranch, base: z.string().min(1).max(255).default('main'), title: z.string().min(1).max(256).optional(), body: z.string().max(60000).default(''), approval_id: z.string().startsWith('apr_').optional() }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_submit', title: 'Submit for review', description: 'Auto-commit if needed, push feature branch + stage, queue draft PR. Returns submission_receipt only (small) — do not invent URLs. Echo receipt fields to the human.', inputSchema: { workspace_id: workspaceIdOptional, branch: forgeBranch, pr_base: z.string().min(1).max(255).default('main'), base: z.string().min(1).max(255).optional(), title: z.string().min(1).max(256).optional(), body: z.string().max(60000).default(''), task_id: taskId.optional(), idempotency_key: idempotencyOptional }, outputSchema: { submitted: z.boolean(), submission_receipt: z.object({ branch: z.string(), remote_sha: z.string(), staged_ref: z.string(), approval_id: z.string(), approval_url: z.string(), files_changed: z.number().int(), feature_branch_on_origin: z.literal(true) }), next_step: z.string() }, sideEffect: 'external', approval: 'deferred' },
  { name: 'forge_cloudflare_deploy', title: 'Deploy to Cloudflare', description: 'Deploy with wrangler using an attached Cloudflare vault secret (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID). Returns deploy_receipt; full logs spill to output_artifact_id. Do not claim live without verified_url.', inputSchema: { workspace_id: workspaceIdOptional, command: z.string().min(1).max(2000).default('npx wrangler deploy'), cwd, expected_url: z.string().url().optional(), include_output: z.boolean().default(false), approval_id: z.string().startsWith('apr_').optional(), idempotency_key: idempotencyOptional }, outputSchema: { deployed: z.boolean(), deploy_receipt: z.object({ account_id: z.string(), worker_name: z.string().nullable(), verified_url: z.string().nullable(), http_status: z.number().int().nullable(), command: z.string() }), output_artifact_id: z.string().optional(), next_step: z.string() }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_work_export', title: 'Export recovery patch', description: 'Export a durable recovery artifact (committed + uncommitted + untracked) for the workspace. Returns artifact_id — use when push is blocked or you need an off-box backup before destroy.', inputSchema: { workspace_id: workspaceIdOptional, max_bytes: z.number().int().min(10_000).max(4_000_000).default(2_000_000) }, outputSchema: { artifact_id: z.string(), size_bytes: z.number().int(), sha256: z.string(), proof: z.unknown(), next_step: z.string() }, sideEffect: 'workspace', approval: 'none' },

  // Review / preview
  { name: 'forge_review', title: 'Review URL', description: 'Screenshot any public URL (no container). Returns images in this call.', inputSchema: { url: z.string().url(), captures: z.array(z.object({ path: z.string().startsWith('/'), state: z.string().min(1).max(100).default('entry'), selection: z.string().min(1).max(200).optional() })).min(1).max(10).default([{ path: '/', state: 'entry' }]), viewports: z.array(z.union([z.enum(['phone','tablet','desktop']), z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(1920), height: z.number().int().min(320).max(2160) })])).min(1).max(3).default(['phone','desktop']), full_page: z.boolean().default(false), time_budget_ms: z.number().int().min(10000).max(110000).default(45000) }, outputSchema: reviewOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_preview_expose', title: 'Expose preview', description: 'Expose a running process through a short-lived Forge preview URL. Private by default; public access needs approval.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_'), port: z.number().int().min(1024).max(65535), access: z.enum(['private','tenant','share-link','public']).default('private'), ttl_seconds: z.number().int().min(60).max(86400).default(3600), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_preview', title: 'Preview capture', description: 'Screenshot your workspace app. Omit preview_id and Forge starts/exposes the dev server. Optional steps drive click/fill before the shot.', inputSchema: { workspace_id: workspaceIdOptional, preview_id: z.string().startsWith('prv_').optional(), preview_wait_ms: z.number().int().min(5000).max(110000).default(60000), captures: z.array(z.object({ route: z.string().startsWith('/'), state: z.string().min(1).max(100).default('entry'), selection: z.string().min(1).max(200).optional(), steps: z.array(z.object({ kind: z.enum(['navigate','click','fill','press','wait_for_selector','wait_for_text','wait','reload']), selector: z.string().min(1).max(1000).optional(), value: z.string().max(10000).optional(), key: z.string().min(1).max(40).optional(), text: z.string().min(1).max(1000).optional(), path: z.string().startsWith('/').optional(), timeout_ms: z.number().int().min(100).max(30000).optional() })).min(1).max(20).optional() })).min(1).max(20), viewports: z.array(z.union([z.enum(['phone','tablet','desktop']), z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(2160) })])).min(1).max(4).default(['phone','desktop']) }, outputSchema: reviewCaptureOutput, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_artifact_get', title: 'Get artifact', description: 'Fetch a stored artifact (images returned as MCP image content).', inputSchema: { workspace_id: workspaceIdOptional, artifact_id: z.string().startsWith('art_'), max_bytes: z.number().int().min(1).max(4000000).default(2500000) }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_artifact_upload', title: 'Upload artifact', description: 'Upload a binary file as a stored artifact. Pass base64-encoded content. Returns artifact id for later retrieval.', inputSchema: { workspace_id: workspaceIdOptional, filename: z.string().min(1).max(200), content_base64: z.string().min(1), content_type: z.string().min(1).max(100).default('application/octet-stream'), metadata: z.record(z.string(), z.string().max(200)).default({}) }, sideEffect: 'workspace', approval: 'none' },

  // Secrets
  { name: 'forge_secret_list', title: 'List secrets', description: 'List stored secrets (labels, providers, env var names). Values never returned.', inputSchema: {}, sideEffect: 'none', approval: 'none' },
  { name: 'forge_secret_create', title: 'Create secret', description: 'Store env vars as a labeled secret. Encrypted at rest; values never returned.', inputSchema: { label: z.string().min(1).max(100), provider: secretProvider, env: secretEnv }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_secret_update', title: 'Update secret', description: 'Update label, provider, or env vars.', inputSchema: { secret_id: secretId, label: z.string().min(1).max(100).optional(), provider: secretProvider.optional(), env: secretEnv.optional() }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_secret_delete', title: 'Delete secret', description: 'Permanently delete a secret and detach it from workspaces.', inputSchema: { secret_id: secretId }, sideEffect: 'destructive', approval: 'none' },
  { name: 'forge_secret_attach', title: 'Attach or detach secret', description: 'Attach (default) or detach (attached:false) a secret on a workspace. Attach requires human approval.', inputSchema: { secret_id: secretId, workspace_id: workspaceIdOptional, attached: z.boolean().default(true), approval_id: z.string().startsWith('apr_').optional() }, sideEffect: 'external', approval: 'required' }
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

