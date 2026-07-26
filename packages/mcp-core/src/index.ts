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
const repository = z.object({ provider: z.literal('github'), owner: z.string().min(1).max(100), name: z.string().min(1).max(100) }).describe('Authorized GitHub repository to act on.');
const cwd = z.string().startsWith('/workspace').default('/workspace/repo').describe('Working directory inside the workspace; must start with /workspace.');
const credentialProfileId = z.string().regex(/^crp_[0-9a-hjkmnp-tv-z]{20,32}$/).describe('Tenant credential profile id (crp_...).');
const credentialMetadata = z.object({
  account_id: z.string().regex(/^[a-f0-9]{32}$/i).optional()
}).default({});
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
  // their own time. See forge_submit_for_review.
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
  nextCursor: z.string().optional().describe('Pass back as `cursor` to fetch the next page. Absent on the last page.'),
  hasMore: z.boolean().describe('True when more files remain; fetch them with `cursor: nextCursor`.'),
  truncated: z.boolean().describe('True when a single file was too large to include whole. Its remaining content is not reachable by paging — read the file with forge_files_read instead.'),
  fileListTruncated: z.boolean().optional().describe('True when even the file list had to be cut, so `files` is incomplete. Narrow with `paths`.'),
  note: z.string()
} satisfies ZodRawShape;

const diffPageOutput = { ...diffPageFields } satisfies ZodRawShape;

const outgoingDiffOutput = {
  ...diffPageFields,
  diffHash: z.string().describe('Stable hash of the COMPLETE outgoing diff, not just this page; pass it back as expected_diff_hash on push. Identical on every page.'),
  branch: z.string().optional(),
  base: z.string()
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
  })),
  reason: z.string().optional().describe('Present only when the list is empty: why there are none (never_installed, revoked, stale_owner, ok).'),
  next_step: z.string().optional().describe('Present only when the list is empty: what the account owner has to do, and where.')
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
  { name: 'forge_capabilities', title: 'Get Forge capability manifest', description: 'Return the stable repository, workspace, Git, recovery, browser, deployment, and approval capabilities available to this MCP session.', inputSchema: {}, sideEffect: 'none', approval: 'none' },
  { name: 'forge_credential_list', title: 'List credential profiles', description: 'List the tenant credential profiles. Secrets and encrypted payloads are never returned.', inputSchema: {}, sideEffect: 'none', approval: 'none' },
  { name: 'forge_credential_create', title: 'Create credential profile', description: 'Encrypt and store a Cloudflare API token as a named tenant profile. The secret is never returned or logged.', inputSchema: { name: z.string().min(1).max(100), provider: z.literal('cloudflare'), secret: z.string().min(16).max(4096), metadata: credentialMetadata, make_active: z.boolean().default(false) }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_credential_update', title: 'Update credential profile', description: 'Rename, replace, or update the metadata of a credential profile. Replacing a secret resets validation state.', inputSchema: { credential_profile_id: credentialProfileId, name: z.string().min(1).max(100).optional(), secret: z.string().min(16).max(4096).optional(), metadata: credentialMetadata.optional(), make_active: z.boolean().optional() }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_credential_delete', title: 'Delete credential profile', description: 'Permanently delete a tenant credential profile.', inputSchema: { credential_profile_id: credentialProfileId }, sideEffect: 'destructive', approval: 'none' },
  { name: 'forge_credential_switch', title: 'Switch credential profile', description: 'Select a profile for this MCP session and mark it active for the tenant.', inputSchema: { credential_profile_id: credentialProfileId }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_credential_validate', title: 'Validate credential profile', description: 'Decrypt a profile only for its provider validation request, then persist its validation state.', inputSchema: { credential_profile_id: credentialProfileId }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_secret_list', title: 'List secrets', description: 'List stored secrets with their labels, providers, and environment variable names. Values are never returned.', inputSchema: {}, sideEffect: 'none', approval: 'none' },
  { name: 'forge_secret_create', title: 'Create a secret', description: 'Store environment variables as a named, labeled secret. Values are encrypted at rest and never returned. Labels must be unique per tenant.', inputSchema: { label: z.string().min(1).max(100).describe('Human-readable label, e.g. "CF Production" or "Shopify - Store A".'), provider: secretProvider, env: secretEnv }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_secret_update', title: 'Update a secret', description: 'Update a stored secret\'s label, provider, or environment variables. Replacing env vars resets validation state.', inputSchema: { secret_id: secretId, label: z.string().min(1).max(100).optional().describe('New label.'), provider: secretProvider.optional(), env: secretEnv.optional() }, sideEffect: 'external', approval: 'none' },
  { name: 'forge_secret_delete', title: 'Delete a secret', description: 'Permanently delete a stored secret and detach it from any workspaces.', inputSchema: { secret_id: secretId }, sideEffect: 'destructive', approval: 'none' },
  { name: 'forge_secret_attach', title: 'Attach secret to workspace', description: 'Attach a stored secret\'s environment variables to a workspace. After human approval, the variables are injected into every command in that workspace. Retry with the returned approval_id once approved.', inputSchema: { secret_id: secretId, workspace_id: workspaceIdOptional, approval_id: z.string().startsWith('apr_').optional().describe('Approval id from a prior approval page.') }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_secret_detach', title: 'Detach secret from workspace', description: 'Remove a stored secret\'s environment variables from a workspace.', inputSchema: { secret_id: secretId, workspace_id: workspaceIdOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_workspace_reconcile', title: 'Reconcile workspace recovery state', description: 'Inspect and reconcile the workspace Git state, processes, and dependency state. Stops or adopts unknown processes, checks for Git lock files, verifies .git/HEAD and index readability, compares HEAD and branch with recorded values, detects package-manager activity, and restores a checkpoint only when necessary. Returns a detailed gitIntegrity report with state, reason, blocking process, and recommended action. Safe to call when Git inspection fails — it never throws, it reports.', inputSchema: { workspace_id: workspaceIdOptional }, outputSchema: { workspaceId: z.string(), gitIntegrity: z.object({ state: z.enum(['consistent', 'unknown', 'diverged', 'corrupted']), reason: z.string(), blockingProcessId: z.string().optional(), gitHeadReadable: z.boolean(), gitIndexReadable: z.boolean(), workingTreeReadable: z.boolean(), recommendedAction: z.string(), destructiveRecoveryRequired: z.boolean() }), processes: z.array(z.object({ id: z.string(), command: z.string(), status: z.string(), exitCode: z.number().optional() })), dependencyState: dependencyStateOut, trackedChangesPreserved: z.boolean(), checkpointRestored: z.boolean(), workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_operation_get', title: 'Get operation status', description: 'Reconcile an uncertain prior mutation by operation id. Returns whether the operation was accepted, is still active (e.g. managed process running), or completed/failed — without inferring from side effects alone.', inputSchema: { workspace_id: workspaceIdOptional, operation_id: z.string().startsWith('op_').describe('Operation id from a prior mutating tool response.') }, outputSchema: { workspaceId: z.string(), operationId: z.string(), idempotencyKey: z.string(), replayed: z.boolean(), originalOperationId: z.string(), status: z.enum(['accepted', 'active', 'completed', 'failed', 'cancelled']), processId: z.string().nullable(), process: z.unknown().nullable(), dependencyState: dependencyStateOut, workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_prove', title: 'Prove workspace state', description: 'Produce one evidence receipt from the actual checkout: immutable base, branch, HEAD, changed paths, filesystem and HEAD file hashes, worktree hash, committed outgoing hash, and recorded-state divergence.', inputSchema: { workspace_id: workspaceIdOptional }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_checkpoint', title: 'Create durable workspace checkpoint', description: 'Create a provider snapshot containing the workspace filesystem and Git data before a risky operation. The checkpoint is retained independently from the active session.', inputSchema: { workspace_id: workspaceIdOptional, name: z.string().min(1).max(120).optional() }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_workspace_restore', title: 'Restore durable workspace checkpoint', description: 'Restore a recorded provider checkpoint into this workspace. Forge blocks restoration over dirty or unpushed work so recovery cannot silently discard a newer change.', inputSchema: { workspace_id: workspaceIdOptional, snapshot_id: z.string().startsWith('snap_'), expected_revision: revision }, sideEffect: 'destructive', approval: 'none' },
  { name: 'forge_work_export', title: 'Export recoverable work', description: 'Persist an evidence-backed recovery bundle to Forge artifacts before risky Git, session, or teardown operations. The export contains committed and uncommitted binary diffs plus a base64 tar.gz archive of all untracked files.', inputSchema: { workspace_id: workspaceIdOptional, max_bytes: z.number().int().min(1000).max(4000000).default(3000000), idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_cloudflare_deploy', title: 'Deploy with Cloudflare Wrangler', description: 'Deploy the workspace with pnpm exec wrangler using the selected Cloudflare profile for this one approved command. The API token is redacted from all results and is never persisted in the sandbox.', inputSchema: { workspace_id: workspaceIdOptional, credential_profile_id: credentialProfileId.optional(), environment: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), config_path: z.string().startsWith('/workspace/repo/').max(500).refine((value) => !value.split('/').includes('..') && !value.includes('\0')).optional(), approval_id: z.string().startsWith('apr_').optional(), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_repository_list', title: 'List authorized repositories', description: 'List the GitHub repositories authorized for this account through the Forge GitHub App. Container-free — use it to pick a repository before starting a task or workspace.', inputSchema: {}, outputSchema: repositoryListOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_start', title: 'Start a task', description: 'Create a durable task record that survives MCP reconnects, context compression and container sleep. Container-free — start a task first for any coherent piece of work, then attach one workspace later only when you need to run or edit code.', inputSchema: { repository, base_ref: z.string().min(1).max(255).default('main').describe('The branch or ref the task branches from.'), goal: z.string().min(1).max(2000).describe('What this task should achieve.'), decisions: z.array(z.string().min(1).max(500)).max(40).default([]).describe('Durable decisions that must survive context compression.'), non_goals: z.array(z.string().min(1).max(500)).max(40).default([]).describe('Things this task deliberately will not do.'), likely_paths: z.array(z.string().min(1).max(500)).max(40).default([]).describe('Files or directories the work is expected to touch.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_get', title: 'Get a task', description: 'Get the full task record: branch, workspace, previews, files read and changed, checks and evidence ids. Read-only and container-free.', inputSchema: { task_id: taskId, compact: z.boolean().optional().describe('Return a token-efficient compact summary.') }, outputSchema: taskGetOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_summary', title: 'Summarize a task', description: 'Get a compact resume summary for a task — goal, decisions, non-goals, state, files, checks, evidence, outstanding work and the next recommended action — so a fresh turn can continue without replaying the session. Excludes source, logs, diffs and secrets. Container-free.', inputSchema: { task_id: taskId, compact: z.boolean().optional().describe('Return a token-efficient compact summary.') }, outputSchema: taskSummaryOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_handoff', title: 'Record task handoff', description: 'Record a structured handoff note on a task so another agent or a fresh ChatGPT chat session can resume work cleanly without context loss.', inputSchema: { task_id: taskId, summary: z.string().min(1).max(2000).describe('Progress summary so far.'), next_steps: z.array(z.string().min(1).max(500)).min(1).max(20).describe('Actionable next steps for the resuming agent.'), key_learnings: z.array(z.string().min(1).max(500)).max(20).optional().describe('Key architecture or bug findings discovered during this session.'), modified_files: z.array(z.string().min(1).max(500)).max(50).optional().describe('Key paths edited or intended for modification.'), blocked_by: z.string().max(500).optional().describe('Any blocker or approval currently required.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_resume', title: 'Resume task in fresh session', description: 'Single-turn recovery for a fresh ChatGPT session or new agent. Returns task goal, active workspace state, latest Git diff summary, checks, and handoff notes in one compact response.', inputSchema: { task_id: taskId, workspace_id: workspaceIdOptional, compact: z.boolean().default(true).describe('Return a tight, context-optimized summary for fast turn recovery.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_context_pack', title: 'Pack bounded context', description: 'Extract and pack essential file signatures, exports, instructions, and path context into a single token-optimized context block for ChatGPT turn initialization. Container-free.', inputSchema: { repository, goal: z.string().min(1).max(2000), paths: z.array(z.string().min(1).max(500)).max(20).optional(), task_id: taskId.optional(), max_tokens: z.number().int().min(500).max(10000).default(4000).describe('Approximate token budget for the packed output.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_list', title: 'List tasks', description: 'List recent tasks for the account, most recently updated first, optionally filtered by state or a free-text query. Container-free.', inputSchema: { state: z.enum(['planning','ready','coding','validating','previewing','reviewing','awaiting-approval','complete','failed','cancelled']).optional().describe('Only return tasks in this state.'), q: z.string().min(1).max(200).optional().describe('Free-text filter matched against the goal, repository, and task details (changed files, decisions, outstanding work).'), limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of tasks to return.') }, outputSchema: { tasks: z.array(z.object(taskSummaryOutput)), returned: z.number().int().describe('How many tasks were returned.'), hint: z.string().optional().describe('Present only when the limit clipped the results.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_task_finish', title: 'Finish a task', description: 'Move a task to a terminal state (complete, failed or cancelled). Container-free. Finishing as \'complete\' is refused when failed/partial checks, unrecorded checks, unpushed changed files or outstanding items are on record — pass force with a note explaining what remains unverified to override.', inputSchema: { task_id: taskId, outcome: z.enum(['complete','failed','cancelled']).describe('The terminal state to move the task to.'), note: z.string().max(2000).optional().describe('Optional closing note added to the task. Required when force is true.'), force: z.boolean().default(false).describe('Override the completion-gap check for outcome complete. Requires note explaining what is unverified.'), expected_revision: revision }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_review', title: 'Review a deployed URL', description: 'Screenshot any live public URL and get the images back in this one call — the cheapest and most reliable path, no container and nothing to poll. Pass just a url to capture it at phone and desktop; add captures to cover more routes. Always returns whatever it managed to capture rather than failing outright. Each cell reports a structure-health signal (structureSummary and evidence[].accessibility.structure) that flags heading defects a screenshot hides — stacked, empty, duplicate or skipped-level headings — which must be resolved or explicitly accepted before the review passes.', inputSchema: { url: z.string().url().describe('The public URL to review.'), captures: z.array(z.object({ path: z.string().startsWith('/').describe('Route path to capture, e.g. /pricing.'), state: z.string().min(1).max(100).default('entry').describe('Label for the page state being captured.'), selection: z.string().min(1).max(200).optional().describe('Optional label for what this evidence covers.') })).min(1).max(10).default([{ path: '/', state: 'entry' }]).describe('Routes to capture. Omit to capture the URL as given.'), viewports: z.array(z.union([z.enum(['phone','tablet','desktop']), z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(1920), height: z.number().int().min(320).max(2160) })])).min(1).max(3).default(['phone','desktop']).describe("Viewports to capture each route at. Use the shorthand names 'phone', 'tablet' or 'desktop', or give explicit sizes."), full_page: z.boolean().default(false).describe('Capture the full scrollable page instead of just the viewport.'), time_budget_ms: z.number().int().min(10000).max(110000).default(45000).describe('Give up capturing after this long and return what succeeded. The default suits chat clients, which abandon a slow tool call and leave you with nothing; raise it when the caller can wait.') }, outputSchema: reviewOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_create', title: 'Create a workspace', description: 'Create a disposable, isolated workspace (a container) from an authorized repository. Costly — create one only when you need to run or edit code; decide with the container-free task and read tools first. By default this call waits until the workspace is actually usable and returns state \'ready\', so there is nothing to poll — the caller does not need to loop. If the wait budget runs out it returns the real state instead, and forge_workspace_get can be used to check again. Forge verifies the requested runtime before reporting success; the maintained Sandbox image defaults to Node 24.', inputSchema: { repository, ref: z.string().default('main').describe('Branch or ref to check out.'), runtime: z.enum(['node-22','node-24','python-3.13','general-purpose']).default('node-24').describe('Runtime image for the container.'), persistence: z.literal('ephemeral').default('ephemeral').describe('Workspaces are always ephemeral.'), bootstrap: z.boolean().default(true).describe('Install dependencies on create.'), wait_for_ready: z.boolean().default(true).describe('Wait for the workspace to become usable before returning, so no polling loop is needed. Set false to return immediately in state \'requested\'.'), wait_budget_ms: z.number().int().min(5000).max(110000).default(60000).describe('How long to wait for readiness before returning the current state anyway.'), idempotency_key: idempotencyOptional }, outputSchema: { workspace_id: z.string(), state: z.string().describe('Lifecycle state at the moment this returned; \'ready\' means usable now.'), operation_id: z.string().optional(), workspace_revision: z.number().optional(), next_step: z.string() }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_workspace_get', title: 'Get a workspace', description: 'Get a compact, reliable workspace summary: branch, head, revision, dependency state, active processes, Git integrity, and allowedNextActions. Prefer compact:true in tight ChatGPT contexts. Read-only.', inputSchema: { workspace_id: workspaceIdOptional, compact: z.boolean().optional().describe('Return a token-efficient compact summary (recommended for ChatGPT).') }, outputSchema: workspaceGetOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_context_get', title: 'Select repository context', description: 'Rank the repository files most relevant to a goal, deterministically (no embeddings, no model). Returns paths with reasons, governing instructions, adjacent tests, package context and warnings — never file contents; you decide what to read. Cheap.', inputSchema: { workspace_id: workspaceIdOptional, goal: z.string().min(1).max(2000).describe('What you are trying to do; drives the ranking.'), task_id: taskId.optional().describe('Optional task to associate the lookup with.'), root: z.string().startsWith('/workspace').default('/workspace/repo').describe('Subtree to rank within.'), max_results: z.number().int().min(1).max(100).default(12).describe('Maximum number of files to return.'), categories: z.array(z.enum(['source','tests','docs','config'])).max(4).optional().describe('Restrict results to these file categories.'), compact: z.boolean().optional().describe('Return a token-efficient compact summary.') }, outputSchema: contextGetOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_diff_metadata', title: 'Summarize the outgoing diff', description: 'Summarize the outgoing diff into deterministic, compact metadata: changed files, additions/deletions, changed exports, tests, config, migrations, possible secret exposure, risk areas and the files worth reading first, plus targeted verification suggestions. Syntax-only and cheap — inspect the raw diff with forge_git_outgoing_diff before any Git mutation.', inputSchema: { workspace_id: workspaceIdOptional, base: z.string().min(1).max(255).default('main').describe('Base branch to diff the current branch against.'), compact: z.boolean().optional().describe('Return a token-efficient compact summary.') }, outputSchema: diffMetadataOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_tree', title: 'List workspace files', description: 'List a bounded, Git-aware file tree under /workspace. Read-only; needs a ready workspace.', inputSchema: { workspace_id: workspaceIdOptional, path: z.string().startsWith('/workspace').default('/workspace/repo').describe('Directory to list.'), depth: z.number().int().min(1).max(20).default(4).describe('How many levels deep to descend.'), limit: z.number().int().min(1).max(10000).default(1000).describe('Maximum number of entries to return.') }, outputSchema: { entries: z.array(z.unknown()).describe('File-tree entries.'), truncated: z.boolean().describe('True when the listing hit the limit.'), hint: z.string().optional().describe('Present only when the listing was truncated.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_read', title: 'Read workspace files', description: 'Read one file (path) or several at once (paths) as bounded text, each with a content hash for conflict-safe edits. Reading several in one call saves round trips; start_line/end_line and max_bytes apply to each file. Needs a ready workspace.', inputSchema: { workspace_id: workspaceIdOptional, path: z.string().startsWith('/workspace').optional().describe('Single file to read.'), paths: z.array(z.string().startsWith('/workspace')).min(1).max(20).optional().describe('Several files to read in one call.'), start_line: z.number().int().positive().optional().describe('First line to include (1-based).'), end_line: z.number().int().positive().optional().describe('Last line to include (1-based).'), max_bytes: z.number().int().min(1).max(500000).default(200000).describe('Per-file byte ceiling.'), compact: z.boolean().optional().describe('Omit verbose wrapper metadata for tight context windows.') }, outputSchema: filesReadOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_files_write', title: 'Write workspace file', description: 'Atomically create or replace one workspace file, then re-read it from the same filesystem before acknowledging success. Pass expected_sha256 for a conflict-safe overwrite. The result includes previous/resulting hashes, workspace revision and worktree hash.', inputSchema: { workspace_id: workspaceIdOptional, path: z.string().startsWith('/workspace/repo/').max(1000).describe('File to create or overwrite inside the repository.'), content: z.string().max(4000000).describe('Full new file content.'), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Hash the file must currently have, for a conflict-safe overwrite; omit to create.'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_files_patch', title: 'Apply a file patch', description: 'Apply a unified diff to the repository. Best for surgical multi-hunk edits; for whole-file rewrites prefer forge_files_write (agents often miscount diff context). idempotency_key must be unique per distinct patch.', inputSchema: { workspace_id: workspaceIdOptional, patch: z.string().min(1).max(1000000).describe('Unified diff to apply.'), idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_shell_exec', title: 'Run a command', description: 'Run a command in the workspace with timeout, output and network-policy bounds. Set async: true to run as a non-blocking process immediately and return proc_ id to avoid HTTP timeouts on long commands. Risky commands return a real user approval URL; idempotency_key must be unique per distinct command.', inputSchema: { workspace_id: workspaceIdOptional, command: z.string().min(1).max(16384).describe('Command to run.'), cwd, timeout_ms: z.number().int().min(100).max(900000).default(300000).describe('Kill the command after this many milliseconds.'), environment: z.record(z.string(), z.string()).default({}).describe('Extra environment variables.'), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist','unrestricted_with_approval']).default('development').describe('Outbound network policy for this command.'), output_limit_bytes: z.number().int().min(1000).max(1000000).default(200000).describe('Truncate captured output past this many bytes.'), async: z.boolean().optional().describe('Set true to start as a background process immediately and return proc_ id in <300ms to avoid chat transport timeout.'), compact: z.boolean().optional().describe('Return compact output for tight context.'), expected_revision: revision, idempotency_key: idempotencyOptional, approval_id: z.string().startsWith('apr_').optional().describe('Approval id returned by a prior blocked call.') }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_process_start', title: 'Start a background process', description: 'Start a managed background process and return its Forge process id immediately. Use for long-running work that must outlive the chat transport — dependency installs (pnpm/npm/yarn), builds, tests, and development servers. Returns mutatesFilesystem when the command writes the workspace. Prefer forge_process_wait afterwards. idempotency_key must be unique per distinct process.', inputSchema: { workspace_id: workspaceIdOptional, command: z.string().min(1).max(16384).describe('Command to run in the background.'), cwd, environment: z.record(z.string(), z.string()).default({}).describe('Extra environment variables. Forge always injects non-interactive defaults (CI, Corepack, Git).'), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist']).default('development').describe('Outbound network policy for this process.'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_process_logs', title: 'Read process logs', description: 'Read only the NEW log bytes after an opaque cursor, plus process status and exit code. Pass nextCursor back until hasMore is false. Read-only.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_').describe('Process id from forge_process_start.'), cursor: z.string().optional().describe('Opaque cursor from a prior page\'s nextCursor. Omit for the first page.') }, outputSchema: processLogsOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_process_get', title: 'Get managed process status', description: 'Read the actual managed process status, command, working directory, mutatesFilesystem flag, and PID for one workspace-owned process.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_') }, outputSchema: { workspaceId: z.string(), process: z.unknown(), recorded: z.unknown().nullable(), dependencyState: dependencyStateOut.optional(), workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_process_list', title: 'List managed processes', description: 'List all workspace-owned managed processes with status, exit codes, and whether filesystem effects were checkpointed. Read-only.', inputSchema: { workspace_id: workspaceIdOptional }, outputSchema: { workspaceId: z.string(), processes: z.array(z.object({ id: z.string(), command: z.string(), status: z.string(), exitCode: z.number().optional(), startedAt: z.string().optional(), completedAt: z.string().optional(), mutatesFilesystem: z.boolean(), filesystemCommitted: z.boolean().optional() })), dependencyState: dependencyStateOut, workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_process_stop', title: 'Stop managed process', description: 'Stop one explicit workspace-owned managed process. Forge never guesses by port or process name. No approval required — this is workspace-local recovery.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_process_wait', title: 'Wait for managed process', description: 'Wait server-side for a managed process to reach a terminal state (exit, failure, or cancellation), or time out. Returns the final process record, dependencyState, and whether filesystem changes were committed. Prefer this over polling forge_process_logs. Wait timeouts are observational: the process is not killed; retry with a larger timeout_ms (use >=600000 for large installs).', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_').describe('Process id from forge_process_start.'), timeout_ms: z.number().int().min(1000).max(600000).default(120000).describe('Maximum time to wait for the process to finish.') }, outputSchema: { workspaceId: z.string(), process: z.unknown(), dependencyState: dependencyStateOut, filesystemCommitted: z.boolean().optional(), finalLogCursor: z.string().nullable().optional(), workspaceRevision: z.number(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_process_cancel', title: 'Cancel managed process', description: 'Cancel (SIGTERM then SIGKILL) one explicit workspace-owned managed process. The process is marked as cancelled and removed from the workspace process table. Use this instead of forge_process_stop when you want to signal that the process was intentionally aborted rather than gracefully stopped. No approval required.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_check_start', title: 'Start durable workspace check', description: 'Start a long-running validation command as a managed workspace check and return immediately with a process id, commit and durable status/log handle.', inputSchema: { workspace_id: workspaceIdOptional, name: z.string().min(1).max(100), command: z.string().min(1).max(16384), cwd, environment: z.record(z.string(), z.string()).default({}), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist']).default('development'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_check_get', title: 'Get workspace check', description: 'Read current status, command, commit and process details for a managed validation check.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_check_cancel', title: 'Cancel workspace check', description: 'Cancel one managed validation check and persist that cancellation.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_dependencies_install', title: 'Install workspace dependencies', description: 'Install dependencies using the detected package manager with the exact pinned version. Detects packageManager from package.json, decides frozen vs non-frozen lockfile, retries safely after network failures, records the resulting lockfile hash, creates a completion checkpoint, and reports whether dependencies are usable. For this repository, Forge automatically selects pnpm with the pinned version from package.json.', inputSchema: { workspace_id: workspaceIdOptional, frozen_lockfile: z.boolean().default(true).describe('Use --frozen-lockfile / --immutable when true (fails if the lockfile is out of sync). Set false to allow lockfile updates.'), allow_lockfile_update: z.boolean().default(false).describe('Allow the install to update the lockfile when it is out of sync with the manifest.'), network_policy: z.enum(['deny_all','package_install','development','custom_allowlist','unrestricted_with_approval']).default('package_install').describe('Outbound network policy for this install.'), timeout_ms: z.number().int().min(10000).max(900000).default(600000).describe('Kill the install after this many milliseconds.'), expected_revision: revision, idempotency_key: idempotencyOptional }, outputSchema: { workspaceId: z.string(), success: z.boolean().optional(), exitCode: z.number().optional(), packageManager: z.string().optional(), installCommand: z.string().optional(), lockfileHashBefore: z.string().optional(), lockfileHashAfter: z.string().optional(), lockfileChanged: z.boolean().optional(), dependencyState: dependencyStateOut, checkpoint: z.object({ snapshotId: z.string(), createdAt: z.string(), providerVersion: z.string() }).optional(), operationId: z.string(), workspaceRevision: z.number(), replayed: z.boolean().optional(), idempotencyKey: z.string().optional(), originalOperationId: z.string().optional(), stderr: z.string().optional(), stdout: z.string().optional(), allowedNextActions: z.array(z.string()).optional() }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_git_status', title: 'Read Git status', description: 'Get the workspace repository\'s working-tree and branch status. Read-only.', inputSchema: { workspace_id: workspaceIdOptional }, outputSchema: gitStatusOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_diff', title: 'Read Git diff', description: 'Get the working-tree (or staged) diff one page of files at a time. Every call returns the COMPLETE list of changed files with line counts; `diff` carries the hunks for that page only. Follow `nextCursor` for the rest, or pass `paths` to jump straight to specific files. Read-only.', inputSchema: { workspace_id: workspaceIdOptional, staged: z.boolean().default(false).describe('Diff staged changes instead of the working tree.'), cursor: diffCursor, max_bytes: diffMaxBytes, paths: diffPaths, compact: z.boolean().optional().describe('Return compact hunk representation.') }, outputSchema: diffPageOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_git_branch_create', title: 'Create a branch', description: 'Create and check out a local branch under the required forge/ namespace.', inputSchema: { workspace_id: workspaceIdOptional, branch: z.string().startsWith('forge/').max(107).describe('Branch name; must start with forge/.'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_git_commit', title: 'Commit changes', description: 'Stage the given repository paths and commit them, attributed to forge-mcp[bot]. Omit message to auto-generate a conventional-commit message from the diff.', inputSchema: { workspace_id: workspaceIdOptional, message: z.string().min(1).max(500).optional().describe('Commit message; omit to auto-generate.'), paths: z.array(z.string().min(1).max(500)).max(100).default([]).describe('Paths to stage; empty stages all changes.'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_git_outgoing_diff', title: 'Inspect the outgoing change', description: 'Get the diff between the base branch and the current forge/ branch, one page of files at a time. Every call returns the COMPLETE list of changed files plus `diffHash` over the WHOLE change (safe to pass to push from any page); `diff` carries the hunks for that page only. Follow `nextCursor` for the rest, or pass `paths` for specific files. Read-only — inspect this before requesting a push.', inputSchema: { workspace_id: workspaceIdOptional, base: z.string().min(1).max(255).default('main').describe('Base branch to compare against.'), cursor: diffCursor, max_bytes: diffMaxBytes, paths: diffPaths, compact: z.boolean().optional().describe('Return compact hunk representation.') }, outputSchema: outgoingDiffOutput, sideEffect: 'none', approval: 'none' },
  { name: 'forge_submit_for_review', title: 'Submit finished work for review', description: 'Finish a piece of work in one call, without waiting for anyone. Stages the current branch on a Forge-owned ref, queues a pull request for it, and returns immediately — the human approves whenever they like, from the Forge portal or the returned URL, and Forge performs the push and opens the draft PR itself. Prefer this over forge_git_push + forge_pull_request_create, which both block until a human clicks. Any uncommitted work is committed automatically, so this is genuinely one call. The workspace can be destroyed straight after this returns; the staged commits outlive it.', inputSchema: { workspace_id: workspaceIdOptional, branch: z.string().startsWith('forge/').max(107).describe('forge/ branch the work should land on once approved.'), base: z.string().min(1).max(255).default('main').describe('Branch the pull request will target.'), title: z.string().min(1).max(256).optional().describe('PR title; omit to auto-generate from the diff.'), body: z.string().max(60000).default('').describe('PR body.'), task_id: taskId.optional().describe('Task this submission completes, for traceability.'), idempotency_key: idempotencyOptional }, outputSchema: { submitted: z.boolean().describe('True once the work is staged and queued for review.'), status: z.string().describe('Lifecycle state of the submission, e.g. awaiting_approval.'), deferred_action_id: z.string().describe('Id of the queued action.'), approval_id: z.string().describe('Approval the human resolves to release it.'), approval_url: z.string().describe('Page where a human can review and approve this submission.'), staged_ref: z.string().describe('Forge-owned ref holding the commits until approval.'), commit: z.string().describe('Commit that will be promoted onto the branch.'), branch: z.string(), base: z.string(), files_changed: z.number().int(), auto_committed: z.boolean().describe('True when uncommitted work was committed as part of submitting.'), next_step: z.string().describe('What the agent should tell the human.') }, sideEffect: 'external', approval: 'deferred' },
  { name: 'forge_git_push', title: 'Push a branch', description: 'Push a non-default forge/ branch through the GitHub App credential proxy. Requires a real user approval page and the expected diff hash.', inputSchema: { workspace_id: workspaceIdOptional, branch: z.string().startsWith('forge/').max(107).describe('forge/ branch to push.'), base: z.string().min(1).max(255).default('main').describe('Base branch the push targets.'), expected_diff_hash: z.string().regex(/^[a-f0-9]{64}$/).describe('diffHash from forge_git_outgoing_diff; the push fails if the diff changed.'), approval_id: z.string().startsWith('apr_').optional().describe('Approval id from the approval page.'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_pull_request_create', title: 'Open a draft pull request', description: 'Open a draft GitHub pull request for an already-pushed forge/ branch. Requires a real user approval page. Omit title to auto-generate the title and body from the branch diff.', inputSchema: { workspace_id: workspaceIdOptional, head: z.string().startsWith('forge/').max(107).describe('forge/ branch to open the PR from.'), base: z.string().min(1).max(255).default('main').describe('Branch to merge into.'), title: z.string().min(1).max(256).optional().describe('PR title; omit to auto-generate.'), body: z.string().max(60000).default('').describe('PR body.'), approval_id: z.string().startsWith('apr_').optional().describe('Approval id from the approval page.') }, sideEffect: 'external', approval: 'required' },
  { name: 'forge_task_authorize_push_envelope', title: 'Pre-authorize a run of pushes', description: 'Ask a human to authorize, ONCE, a bounded envelope covering the next several forge_git_push calls to one branch — for tasks that iterate in many small commit-then-push cycles, so the human is not asked to click through every single push. A push only auto-satisfies inside the envelope while it (a) fast-forwards the same branch/base with no rewritten history, and (b) touches only paths under allowed_paths; anything else falls back to a normal, individually-approved push. Never covers forge_pull_request_create, which always needs its own approval. Requires a real user approval page, same as a push.', inputSchema: { workspace_id: workspaceIdOptional, task_id: taskId.optional().describe('Task this envelope belongs to, for traceability.'), branch: z.string().startsWith('forge/').max(107).describe('forge/ branch the envelope covers.'), base: z.string().min(1).max(255).default('main').describe('Base branch, fixed for the life of the envelope.'), allowed_paths: z.array(z.string().min(1).max(500)).min(1).max(50).optional().describe('Path prefixes the envelope covers. Omit to default to the paths in the current outgoing diff.'), ttl_minutes: z.number().int().min(5).max(480).default(120).describe('How long the envelope stays valid.'), approval_id: z.string().startsWith('apr_').optional().describe('Approval id from the approval page.') }, sideEffect: 'none', approval: 'required' },
  { name: 'forge_preview_expose', title: 'Expose a preview', description: 'Expose a running process through a short-lived Forge preview capability. Private by default; public access requires approval.', inputSchema: { workspace_id: workspaceIdOptional, process_id: z.string().startsWith('proc_').describe('Process to expose.'), port: z.number().int().min(1024).max(65535).describe('Port the process listens on.'), access: z.enum(['private','tenant','share-link','public']).default('private').describe('Who can reach the preview.'), ttl_seconds: z.number().int().min(60).max(86400).default(3600).describe('How long the preview stays open.'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'workspace', approval: 'policy' },
  { name: 'forge_review_capture', title: 'Capture preview review evidence', description: 'Screenshot your own running app in the workspace and get the images back in this call. Omit preview_id and Forge starts the dev server and exposes it for you, so this is one call rather than a start-poll-expose-capture sequence. Give a capture `steps` to drive a real interaction (click/fill/press/wait) before the shot, proving multi-step flows a static screenshot cannot. Screenshots come back attached to the result; this is the only preview-evidence tool.', inputSchema: { workspace_id: workspaceIdOptional, preview_id: z.string().startsWith('prv_').optional().describe('Preview id from forge_preview_expose. Optional — omit it and Forge starts the project dev server and exposes it for you, which is usually what you want.'), preview_wait_ms: z.number().int().min(5000).max(110000).default(60000).describe('How long to wait for the dev server to come up when Forge is starting it.'), captures: z.array(z.object({ route: z.string().startsWith('/').describe('Route path to capture, e.g. /cart.'), state: z.string().min(1).max(100).default('entry').describe('Label for the page state being captured.'), selection: z.string().min(1).max(200).optional().describe('Optional label for what this evidence covers.'), steps: z.array(z.object({ kind: z.enum(['navigate','click','fill','press','wait_for_selector','wait_for_text','wait','reload']), selector: z.string().min(1).max(1000).optional(), value: z.string().max(10000).optional(), key: z.string().min(1).max(40).optional(), text: z.string().min(1).max(1000).optional(), path: z.string().startsWith('/').optional(), timeout_ms: z.number().int().min(100).max(30000).optional() })).min(1).max(20).optional().describe('Interaction to drive before the shot.') })).min(1).max(20).describe('Routes to capture.'), viewports: z.array(z.union([z.enum(['phone','tablet','desktop']), z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(2160) })])).min(1).max(4).default(['phone','desktop']).describe("Viewports to capture each route at. Use the shorthand names 'phone', 'tablet' or 'desktop', or give explicit sizes.") }, outputSchema: reviewCaptureOutput, sideEffect: 'workspace', approval: 'none' },
  { name: 'forge_artifact_get', title: 'Get an artifact', description: 'Fetch a stored Forge artifact. Image artifacts are returned as MCP image content for direct model inspection. Read-only.', inputSchema: { workspace_id: workspaceIdOptional, artifact_id: z.string().startsWith('art_').describe('Artifact id, e.g. from evidence[].screenshot.artifactId.'), max_bytes: z.number().int().min(1).max(4000000).default(2500000).describe('Maximum bytes to return.') }, sideEffect: 'none', approval: 'none' },
  { name: 'forge_workspace_destroy', title: 'Destroy a workspace', description: 'Destroy a workspace: revoke previews and capabilities, stop processes and tear down the container. Do this once the task or review is complete. Refused when the repository has committed changes on a forge/ branch that were never pushed — pass force to destroy anyway and accept the loss.', inputSchema: { workspace_id: workspaceIdOptional, preserve_artifacts: z.boolean().default(true).describe('Keep captured artifacts after teardown.'), force: z.boolean().default(false).describe('Destroy even if the workspace has unpushed committed work.'), expected_revision: revision, idempotency_key: idempotencyOptional }, sideEffect: 'destructive', approval: 'policy' }
] as const satisfies readonly ForgeToolDefinition[];

export type ForgeToolName = typeof forgeTools[number]['name'];
export type ForgeToolHandler = (input: Record<string, unknown>) => Promise<Record<string, unknown> | ForgeToolResponse>;
export type ForgeToolHandlers = Record<ForgeToolName, ForgeToolHandler>;

export interface ForgeMcpAdapter {
  registerTool(definition: ForgeToolDefinition, handler: ForgeToolHandler): void;
  connect(request: Request, context: { subject: string; tenantId: string }): Promise<Response>;
}
