import { describe, expect, it } from 'vitest';
import { forgeTools, type ForgeToolHandlers } from '@forge/mcp-core';
import { registerForgeToolsV1, toolAnnotations } from '../../packages/mcp-adapter-v1/src/index';

const PUBLIC_TOOL_NAMES = [
  'forge_repositories',
  'forge_search',
  'forge_read',
  'forge_edit',
  'forge_run',
  'forge_screenshot',
  'forge_environments',
  'forge_deploy',
  'forge_submit',
  'forge_merge',
  'forge_status'
];

function tool(name: string) {
  const result = forgeTools.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing tool ${name}`);
  return result;
}

describe('Forge direct-chat MCP contract', () => {
  it('exposes exactly the eleven direct tools and no control-plane catalog', () => {
    expect(forgeTools.map((entry) => entry.name)).toEqual(PUBLIC_TOOL_NAMES);
    expect(new Set(forgeTools.map((entry) => entry.name)).size).toBe(PUBLIC_TOOL_NAMES.length);

    for (const forbidden of [
      'forge_workspace_create', 'forge_task_create', 'forge_files_read',
      'forge_shell', 'forge_process_wait', 'forge_preview',
      'forge_deploy_profiles', 'forge_site_review'
    ]) {
      expect(forgeTools.some((entry) => entry.name === forbidden), forbidden).toBe(false);
    }
  });

  it('uses bounded direct-chat inputs and a shared compact receipt', () => {
    const edit = tool('forge_edit').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(edit.files.safeParse([{ path: 'docs/DESIGN.md', content: '# Direction' }]).success).toBe(true);
    expect(edit.files.safeParse(Array.from({ length: 11 }, (_, index) => ({ path: `a${index}.md`, content: 'x' }))).success).toBe(false);
    expect(edit.intent.safeParse(undefined).success).toBe(true);

    const run = tool('forge_run').inputSchema as Record<string, { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } }>;
    expect(run.timeout_ms.parse(undefined)).toBe(600_000);
    expect(run.timeout_ms.safeParse(600_001).success).toBe(false);

    const screenshot = tool('forge_screenshot').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(screenshot.target.safeParse('https://example.com').success).toBe(true);
    expect(screenshot.target.safeParse('').success).toBe(false);

    const merge = tool('forge_merge').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(merge.pull_request.safeParse(7).success).toBe(true);
    expect(merge.pull_request.safeParse(0).success).toBe(false);
    expect(tool('forge_merge').approval).toBe('deferred');

    for (const definition of forgeTools) {
      const receipt = definition.outputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
      expect(receipt.state.safeParse('completed').success).toBe(true);
      expect(receipt.summary.safeParse('Committed on GitHub.').success).toBe(true);
      expect(receipt.next_action.safeParse('none').success).toBe(true);
      expect(receipt.next_action.safeParse({ kind: 'human', message: 'Open the status URL.' }).success).toBe(true);
    }
  });

  it('marks only direct observations as read-only and screenshots as open-world', () => {
    expect(toolAnnotations('forge_repositories', 'none')).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(toolAnnotations('forge_search', 'none')).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(toolAnnotations('forge_screenshot', 'none')).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(toolAnnotations('forge_edit', 'external')).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(toolAnnotations('forge_deploy', 'external')).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it('registers one direct catalog without widgets or output schemas', () => {
    const registered: Record<string, unknown>[] = [];
    const server = {
      registerTool(_name: string, config: Record<string, unknown>) {
        registered.push(config);
      }
    } as never;
    const handlers = new Proxy({}, { get: () => async () => ({}) }) as ForgeToolHandlers;

    registerForgeToolsV1(server, handlers);

    expect(registered).toHaveLength(PUBLIC_TOOL_NAMES.length);
    for (const config of registered) {
      expect(config).not.toHaveProperty('outputSchema');
      const meta = (config._meta ?? {}) as Record<string, unknown>;
      expect(meta).not.toHaveProperty('ui');
      expect(meta).not.toHaveProperty('openai/outputTemplate');
    }
  });
});
