import { z, type ZodRawShape } from 'zod';

/** A direct Chat response may additionally carry MCP image content. */
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

export interface ForgeToolDefinition<TShape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: TShape;
  /** Internal drift telemetry only. Never register this schema on the MCP wire. */
  outputSchema?: ZodRawShape;
  sideEffect: 'none' | 'workspace' | 'external' | 'destructive';
  approval: 'none' | 'policy' | 'required' | 'deferred';
}

const repository = z.string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  .describe('Authorized GitHub repository, written owner/repo.');
const ref = z.string().min(1).max(255).optional().describe('Branch, tag, or commit SHA. Omit to use the repository default/current intent branch.');
const branchRef = z.string().min(1).max(255).optional().describe('GitHub branch. Omit to use the repository default branch.');
const intentRef = z.string().min(1).max(255).describe('Exact forge/chat-* intent branch returned by forge_edit.');
const path = z.string().min(1).max(1000).describe('Repository-relative path.');
const idempotencyKey = z.string().min(8).max(200).optional().describe('Optional stable retry key. Omit for a new request.');
const viewport = z.union([
  z.enum(['phone', 'tablet', 'desktop']),
  z.object({ id: z.string().min(1).max(40), width: z.number().int().min(240).max(3840), height: z.number().int().min(320).max(2160) })
]);
const interaction = z.object({
  kind: z.enum(['navigate', 'click', 'fill', 'press', 'wait_for_selector', 'wait_for_text', 'wait', 'reload']),
  selector: z.string().min(1).max(1000).optional(),
  value: z.string().max(10_000).optional(),
  key: z.string().min(1).max(40).optional(),
  text: z.string().min(1).max(1000).optional(),
  path: z.string().startsWith('/').optional(),
  timeout_ms: z.number().int().min(100).max(30_000).optional()
});

/**
 * Every direct tool returns this receipt. Witness fields are optional because
 * a repository read, a public-URL capture, and a deferred deploy have
 * different durable evidence, but ordinary Chat always gets state, summary,
 * and exactly one useful next action.
 */
const compactReceipt = {
  state: z.enum(['completed', 'running', 'approval_required', 'failed', 'expired']),
  summary: z.string().min(1).max(2000),
  next_action: z.union([
    z.literal('none'),
    z.object({
      kind: z.enum(['tool', 'human']),
      message: z.string().min(1).max(2000),
      tool: z.string().min(1).max(100).optional()
    })
  ]).describe('The one useful continuation: none, a human action, or one public Forge tool action.'),
  repository: z.string().optional(),
  ref: z.string().optional(),
  commit_sha: z.string().optional(),
  commit_url: z.string().url().optional(),
  operation_id: z.string().optional(),
  status_url: z.string().url().optional(),
  approval_url: z.string().url().optional(),
  gallery_url: z.string().url().optional(),
  deployment_url: z.string().url().optional(),
  remote_persisted: z.boolean().optional()
} satisfies ZodRawShape;

const receipt = () => ({ ...compactReceipt });

const editFile = z.object({
  path,
  content: z.string().max(200_000).nullable().optional().describe('Whole new file content; null deletes the file.'),
  replace: z.array(z.object({
    old: z.string().min(1).max(100_000),
    new: z.string().max(100_000),
    all: z.boolean().optional()
  })).min(1).max(20).optional().describe('Unambiguous fragment replacements. Prefer this for existing files.')
});

/**
 * The only public Forge catalog. It is deliberately designed for a chat that
 * may stop after any result: no task, workspace, process, secret, preview, or
 * approval lifecycle identifier is needed to continue a normal flow.
 */
export const forgeTools = [
  {
    name: 'forge_repositories',
    title: 'Repositories',
    description: 'List or filter GitHub repositories authorized for Forge. Explains how to reconnect or grant access when a repository is missing.',
    inputSchema: { query: z.string().min(1).max(200).optional() },
    outputSchema: receipt(), sideEffect: 'none', approval: 'none'
  },
  {
    name: 'forge_search',
    title: 'Search repository',
    description: 'Search file paths and text directly in GitHub. Does not start compute.',
    inputSchema: { repository, ref, query: z.string().min(1).max(1000), path: path.optional(), max_results: z.number().int().min(1).max(50).default(20) },
    outputSchema: receipt(), sideEffect: 'none', approval: 'none'
  },
  {
    name: 'forge_read',
    title: 'Read repository',
    description: 'Read up to 20 files or directories directly from GitHub. Directory paths return a bounded listing; no compute is started.',
    inputSchema: { repository, ref, paths: z.array(path).min(1).max(20), max_bytes: z.number().int().min(1).max(500_000).default(200_000) },
    outputSchema: receipt(), sideEffect: 'none', approval: 'none'
  },
  {
    name: 'forge_edit',
    title: 'Edit and commit',
    description: 'Make a small, bounded repository change. Forge creates or reuses an intent branch, commits to GitHub, and verifies the remote commit before reporting success. Command-created files are never saved by this tool.',
    inputSchema: {
      repository, ref,
      intent: z.string().min(1).max(1000).optional().describe('Required when starting a new intent branch; omit only when ref names an existing intent branch.'),
      base_ref: z.string().min(1).max(255).optional(),
      files: z.array(editFile).min(1).max(10).describe('At most 10 files and 200 KB combined content (enforced by Forge).'),
      message: z.string().min(1).max(500).optional(),
      idempotency_key: idempotencyKey
    },
    outputSchema: receipt(), sideEffect: 'external', approval: 'none'
  },
  {
    name: 'forge_run',
    title: 'Run command',
    description: 'Run one command against the exact GitHub revision. Forge handles checkout and dependencies. File changes produced by commands are ephemeral and never committed automatically.',
    inputSchema: { repository, ref: branchRef, command: z.string().min(1).max(16_384), cwd: z.string().min(1).max(1000).default('/workspace/repo'), timeout_ms: z.number().int().min(100).max(600_000).default(600_000).describe('Maximum command runtime. Forge returns a status URL when work outlives the host-safe synchronous window.'), idempotency_key: idempotencyKey },
    outputSchema: receipt(), sideEffect: 'workspace', approval: 'policy'
  },
  {
    name: 'forge_screenshot',
    title: 'Screenshot',
    description: 'Capture a public URL or owner/repo#ref at responsive breakpoints. Repository captures start and expose the preview internally; screenshots are returned inline when available.',
    inputSchema: {
      target: z.string().min(1).max(1000).describe('Public URL or authorized repository reference: owner/repo or owner/repo#ref.'),
      paths: z.array(z.string().startsWith('/')).min(1).max(10).default(['/']),
      viewports: z.array(viewport).min(1).max(4).default(['phone', 'desktop']),
      steps: z.array(interaction).max(20).optional(),
      full_page: z.boolean().default(false),
      time_budget_ms: z.number().int().min(10_000).max(40_000).default(40_000)
    },
    outputSchema: receipt(), sideEffect: 'none', approval: 'none'
  },
  {
    name: 'forge_environments',
    title: 'Deployment environments',
    description: 'List saved deployment environments and readiness for a repository. Returns labels and providers only; secret values and mappings never leave Forge.',
    inputSchema: { repository },
    outputSchema: receipt(), sideEffect: 'none', approval: 'none'
  },
  {
    name: 'forge_deploy',
    title: 'Deploy',
    description: 'Request deployment of an exact GitHub revision through a saved environment. Returns a deferred approval/status URL; Forge runs the approved deployment without another Chat call.',
    inputSchema: { repository, ref: branchRef, environment: z.string().min(1).max(100), idempotency_key: idempotencyKey },
    outputSchema: receipt(), sideEffect: 'external', approval: 'deferred'
  },
  {
    name: 'forge_submit',
    title: 'Submit for review',
    description: 'Seal an intent branch and submit its verified GitHub revision for deferred review and draft pull-request creation.',
    inputSchema: { repository, ref: intentRef, title: z.string().min(1).max(256).optional(), body: z.string().max(60_000).optional(), idempotency_key: idempotencyKey },
    outputSchema: receipt(), sideEffect: 'external', approval: 'deferred'
  },
  {
    name: 'forge_status',
    title: 'Status',
    description: 'Recover the latest Forge result for a repository/ref or durable operation ID. Never restarts work and is not required for normal flows.',
    inputSchema: { target: z.string().min(1).max(1000).optional().describe('owner/repo, owner/repo#ref, or operation ID from a prior receipt. Omit to recover the most recent operation.') },
    outputSchema: receipt(), sideEffect: 'none', approval: 'none'
  }
] as const satisfies readonly ForgeToolDefinition[];

export type ForgeToolName = typeof forgeTools[number]['name'];
export type ForgeToolHandler = (input: Record<string, unknown>) => Promise<Record<string, unknown> | ForgeToolResponse>;
export type ForgeToolHandlers = { [K in ForgeToolName]: ForgeToolHandler };

/** Private low-level handler map retained while direct tools compose it. */
export type LegacyForgeToolHandlers = Record<string, ForgeToolHandler>;

/** Runtime check that every advertised direct tool has a handler. */
export function assertForgeToolHandlers(handlers: Partial<Record<string, ForgeToolHandler>>): ForgeToolHandlers {
  const missing = forgeTools.filter((tool) => typeof handlers[tool.name] !== 'function').map((tool) => tool.name);
  if (missing.length > 0) throw new Error(`Missing Forge tool handlers: ${missing.join(', ')}`);
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
