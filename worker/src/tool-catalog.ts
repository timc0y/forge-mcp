import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext, ToolOutcome } from './tool-types';
import { toForgeError } from './errors';
import { readRepository } from './repository-reader';
import { author } from './authoring';
import { prepareApproval } from './approval-evidence';
import { captureResult } from './capture-result';
import { utf8Bytes } from './evidence';

export type { ToolContext } from './tool-types';
const receipt = { changes: z.array(z.string()).optional(), limits: z.array(z.string()).optional(), next: z.string().optional() };
const readOutput = {
  source: z.object({ repo: z.string(), requested: z.string(), sha: z.string(), private: z.boolean() }).optional(),
  ...Object.fromEntries(['repos', 'tree', 'files', 'diff', 'baseSha', 'history', 'churn', 'policy', 'observedAt', 'languages', 'migrations', 'scripts', 'configurations', 'declarations', 'context', 'search', 'checks', 'analysis', 'upstream', 'kind', 'matches', 'coverage'].map((key) => [key, z.unknown().optional()])),
  ...receipt
};
async function run(tool: string, ctx: ToolContext, work: () => Promise<ToolOutcome>) {
  const started = Date.now();
  try {
    const result = await work();
    ctx.track('tool_called', { tool, ok: true, ms: Date.now() - started, output_bytes: utf8Bytes(JSON.stringify(result.structured)) });
    return { content: [{ type: 'text' as const, text: result.summary }, ...(result.content ?? [])], structuredContent: result.structured };
  } catch (thrown) {
    const error = toForgeError(thrown);
    ctx.track('tool_called', { tool, ok: false, code: error.code, ms: Date.now() - started });
    if (error.code === 'FORGE_QUOTA_EXCEEDED') ctx.track('quota_refused', { tool });
    console.error('forge_tool_failed', { tool, code: error.code });
    const retryAfter = typeof error.details?.retryAfter === 'string' && error.details.retryAfter ? ` Retry-After: ${error.details.retryAfter}.` : '';
    return { isError: true, content: [{ type: 'text' as const, text: `${error.code}: ${error.message}${retryAfter}` }] };
  }
}
const fileInput = z.object({
  path: z.string(), content: z.string().nullable().optional(),
  replace: z.array(z.object({ old: z.string(), new: z.string(), all: z.boolean().optional() }).strict()).optional(),
  edit: z.object({ expectedCommit: z.string().regex(/^[0-9a-f]{40}$/), selector: z.string(), replacement: z.string() }).strict().optional()
}).strict();
export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('forge_read', {
    title: 'Read',
    description: 'Read immutable GitHub source or evidence. Exact paths win over questions. at="proposal" reads proposed contents; change alone reads a diff. Natural questions compile context. Public GitHub research uses repo="global". No execution or private-scope widening.',
    inputSchema: {
      repo: z.string().optional().describe('owner/repo, reachable name, GitHub URL, or global. Omit to list reachable repositories.'),
      change: z.string().optional().describe('An open change, by its title or forge.'),
      at: z.string().optional().describe('Full commit SHA, or proposal for actual proposed source.'),
      paths: z.array(z.string()).max(20).optional().describe('Paths/ranges, path::symbol:Name, path::id:ID or path::pointer:/key.'),
      query: z.string().optional().describe('Task or checks, analysis, quality, history, stats, map, instructions, symbols <path>, find:<literal>, upstream <public package>. Global bare names discover repositories; code: finds public occurrences.')
    },
    outputSchema: readOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (input) => run('forge_read', ctx, () => readRepository(ctx, input)));
  server.registerTool('forge_edit', {
    title: 'Edit',
    description: 'Commit directly by omitting change; give a review reason to use the one fixed branch. Exact fragments or revision-checked selectors avoid resending large files. A commit is on GitHub before return. Syntax checks are not tests.',
    inputSchema: {
      repo: z.string(), change: z.string().trim().min(1).optional(),
      intent: z.string().optional().describe('Retired input; rejected. Refresh the client and use change.'),
      message: z.string().trim().min(1), files: z.array(fileInput).min(1).max(10), private: z.boolean().optional()
    },
    outputSchema: { commit: z.object({ repo: z.string(), branch: z.string(), sha: z.string(), url: z.string(), outcome: z.enum(['committed', 'unchanged']) }), change: z.string().optional(), review: z.string().optional(), ...receipt },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async (input) => run('forge_edit', ctx, () => author(ctx, input)));
  const approvalOutput = { approval: z.object({ url: z.string(), expires: z.string() }).optional(), evidence: z.string().optional(), ...receipt };
  server.registerTool('forge_merge', {
    title: 'Merge', description: 'Prepare a SHA-fenced human merge approval after checking current evidence. Returns one approval link; does not itself merge.',
    inputSchema: { repo: z.string(), change: z.string() }, outputSchema: approvalOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async (input) => run('forge_merge', ctx, () => prepareApproval(ctx, 'merge', input.repo, input.change)));
  server.registerTool('forge_discard', {
    title: 'Discard', description: 'Prepare human approval to close and discard a Forge change, stating whether unmerged work would be lost. Does not itself discard.',
    inputSchema: { repo: z.string(), change: z.string() }, outputSchema: approvalOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async (input) => run('forge_discard', ctx, () => prepareApproval(ctx, 'discard', input.repo, input.change)));
  server.registerTool('forge_see', {
    title: 'See', description: 'Capture an already-public page at phone and desktop unless specified. Images come back with this call; nothing to fetch afterwards. The outline is observation, not an AI diagnosis.',
    inputSchema: { url: z.string(), viewports: z.array(z.enum(['phone', 'tablet', 'desktop'])).max(3).optional() },
    outputSchema: { page: z.object({ url: z.string(), title: z.string(), shown: z.array(z.string()) }).optional(), quota: z.string().optional(), limits: z.array(z.string()).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (input) => run('forge_see', ctx, () => captureResult(ctx, input.url, input.viewports)));
}
