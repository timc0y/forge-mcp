import { describe, expect, it } from 'vitest';
import { forgeTools } from '@forge/mcp-core';
import { toolAnnotations, registerForgeToolsV1 } from '../../packages/mcp-adapter-v1/src/index';
import type { ForgeToolHandlers } from '@forge/mcp-core';

function tool(name: string) {
  const result = forgeTools.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing tool ${name}`);
  return result;
}

describe('Forge MCP public contracts', () => {
  it('keeps the KISS catalog small and unique', () => {
    // The bound exists because the catalog is re-sent every turn: 42 tools
    // cost ~10.7k tokens per turn. Raised from 40 to 45 for forge_pr,
    // forge_access, forge_history and forge_branches — each ~150-280 tokens,
    // and each removes an operation that otherwise requires a browser. Raise
    // it again only for a tool that earns its rent the same way.
    expect(forgeTools.length).toBeLessThanOrEqual(45);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_edit')).toBe(true);
    const names = forgeTools.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not expose unimplemented workspace options or self-declared approval', () => {
    const create = tool('forge_workspace_create').inputSchema as Record<string, unknown>;
    expect(create).not.toHaveProperty('start_preview');
    expect(Object.keys(create)).toContain('persistence');
    const persistence = create.persistence as { safeParse(value: unknown): { success: boolean } };
    expect(persistence.safeParse('ephemeral').success).toBe(true);
    expect(persistence.safeParse('persistent').success).toBe(false);
    const shell = tool('forge_shell').inputSchema as Record<string, unknown>;
    expect(shell).not.toHaveProperty('approved');
    expect(shell).toHaveProperty('approval_id');
  });

  it('advertises no ui:// widget on any tool, so hosts render plain results', () => {
    const registered: Record<string, unknown>[] = [];
    const server = {
      registerTool(_name: string, config: Record<string, unknown>) {
        registered.push(config);
      }
    } as never;
    const handlers = new Proxy({}, { get: () => async () => ({}) }) as ForgeToolHandlers;

    registerForgeToolsV1(server, handlers);

    expect(registered.length).toBe(forgeTools.length);
    for (const config of registered) {
      const meta = (config._meta ?? {}) as Record<string, unknown>;
      expect(meta).not.toHaveProperty('ui');
      expect(meta).not.toHaveProperty('openai/outputTemplate');
      for (const key of Object.keys(meta)) {
        expect(key).toMatch(/^openai\/toolInvocation\//);
      }
    }
  });

  it('marks only retry-safe tools idempotent and true reads read-only', () => {
    expect(toolAnnotations('forge_review', 'none')).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(toolAnnotations('forge_merge', 'external')).toMatchObject({ idempotentHint: false });
    expect(toolAnnotations('forge_files_read', 'none')).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(toolAnnotations('forge_workspace_create', 'workspace')).toMatchObject({ idempotentHint: true });
    expect(toolAnnotations('forge_edit', 'external')).toMatchObject({ idempotentHint: false });
  });

  it('exposes no git plumbing at all', () => {
    // The point of remote-first editing is that an agent cannot reason about
    // pushing, because there is nothing to push and no tool to push with.
    // Every name here existed to manage the gap between a local edit and
    // GitHub; closing that gap deletes the gap and its tools together.
    const gone = [
      'forge_git_status', 'forge_git_diff', 'forge_git_branch', 'forge_git_rebase',
      'forge_git_commit', 'forge_git_push', 'forge_git_sync', 'forge_pull_request_create',
      'forge_files_write', 'forge_files_write_batch', 'forge_files_replace',
      'forge_files_patch', 'forge_files_upload',
      // Recovery tools that only existed to clean up after lost work.
      'forge_work_export', 'forge_doctor', 'forge_workspace_prove'
    ];
    for (const name of gone) {
      expect(forgeTools.some((candidate) => candidate.name === name), name).toBe(false);
    }
    expect(forgeTools.some((candidate) => candidate.name === 'forge_process_stop')).toBe(true);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_observer_workspaces')).toBe(true);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_cloudflare_deploy')).toBe(true);
  });

  it('commits remotely rather than mutating a workspace', () => {
    // forge_edit is an external side effect because the commit lands on
    // GitHub during the call — not a workspace mutation awaiting a push.
    const edit = tool('forge_edit');
    expect(edit.sideEffect).toBe('external');
    expect(edit.approval).toBe('none');
    const schema = edit.inputSchema as Record<string, unknown>;
    expect(Object.keys(schema)).toContain('files');
    expect(Object.keys(schema)).not.toContain('expected_revision');
  });

  it('exposes secret vault tools (detach folded into attach)', () => {
    const expected = ['forge_secret_list', 'forge_secret_create', 'forge_secret_update', 'forge_secret_delete', 'forge_secret_attach'];
    for (const name of expected) {
      expect(forgeTools.some((candidate) => candidate.name === name)).toBe(true);
    }
    expect(forgeTools.some((candidate) => candidate.name === 'forge_secret_detach')).toBe(false);
    const attach = tool('forge_secret_attach').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(attach.attached.safeParse(false).success).toBe(true);
  });

  it('forge_secret_create rejects an empty env map', () => {
    const schema = tool('forge_secret_create').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean; error?: unknown } }>;
    expect(schema.label.safeParse('CF Production').success).toBe(true);
    expect(schema.label.safeParse('').success).toBe(false);
    expect(schema.label.safeParse('a'.repeat(101)).success).toBe(false);
    expect(schema.provider.safeParse('cloudflare').success).toBe(true);
    expect(schema.provider.safeParse('shopify').success).toBe(true);
    expect(schema.provider.safeParse('generic').success).toBe(true);
    expect(schema.provider.safeParse('aws').success).toBe(false);
    expect(schema.env.safeParse({ API_KEY: 'secret' }).success).toBe(true);
    expect(schema.env.safeParse({}).success).toBe(false);
  });

  it('forge_secret_update accepts partial updates', () => {
    const schema = tool('forge_secret_update').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.secret_id.safeParse('sec_00000000000000000000000000').success).toBe(true);
    expect(schema.secret_id.safeParse('crp_00000000000000000000000000').success).toBe(false);
    expect(schema.secret_id.safeParse('not-an-id').success).toBe(false);
    expect(schema.label.safeParse('New Label').success).toBe(true);
    expect(schema.provider.safeParse(undefined).success).toBe(true);
    expect(schema.env.safeParse(undefined).success).toBe(true);
  });

  it('forge_secret_attach requires a valid secret_id', () => {
    const schema = tool('forge_secret_attach').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.secret_id.safeParse('sec_00000000000000000000000000').success).toBe(true);
    expect(schema.secret_id.safeParse('sec_bad').success).toBe(false);
    expect(schema.approval_id.safeParse(undefined).success).toBe(true);
    expect(schema.approval_id.safeParse('apr_00000000000000000000000000').success).toBe(true);
    expect(schema.approval_id.safeParse('not-an-approval').success).toBe(false);
  });

  it('forge_secret_delete rejects invalid secret ids', () => {
    const schema = tool('forge_secret_delete').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.secret_id.safeParse('sec_00000000000000000000000000').success).toBe(true);
    expect(schema.secret_id.safeParse('').success).toBe(false);
  });

  it('requires schema-safe dependencyState object on forge_workspace_get output', () => {
    const schema = tool('forge_workspace_get').outputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.dependencyState.safeParse(null).success).toBe(false);
    expect(schema.dependencyState.safeParse({
      status: 'unknown',
      reason: 'not_observed',
      usable: false
    }).success).toBe(true);
    expect(schema.dependencyState.safeParse({
      status: 'ready',
      reason: 'installed',
      lockfileHash: 'a'.repeat(64),
      installedAt: '2026-07-26T00:00:00.000Z',
      usable: true
    }).success).toBe(true);
    expect(schema.dependencyState.safeParse({ usable: true }).success).toBe(false);
  });

  it('includes schema-safe dependencyState on forge_process_wait output', () => {
    const schema = tool('forge_process_wait').outputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.dependencyState.safeParse(null).success).toBe(false);
    expect(schema.dependencyState.safeParse({
      status: 'unusable',
      reason: 'install_not_visible',
      lockfileHash: 'a'.repeat(64),
      installedAt: '2026-07-26T00:00:00.000Z',
      usable: false
    }).success).toBe(true);
  });

  it('exposes process list, operation get, read_only shell, and incremental logs', () => {
    expect(tool('forge_process_list').sideEffect).toBe('none');
    expect(tool('forge_operation_get').sideEffect).toBe('none');
    expect(forgeTools.some((candidate) => candidate.name === 'forge_operation_reconcile')).toBe(false);
    const logs = tool('forge_process_logs').outputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(logs.nextCursor.safeParse(null).success).toBe(true);
    expect(logs.hasMore.safeParse(true).success).toBe(true);
    expect(logs.status.safeParse('running').success).toBe(true);
    expect(tool('forge_shell').description).toMatch(/async:true/i);
    const shell = tool('forge_shell').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(shell.mode.safeParse('read_only').success).toBe(true);
    expect(shell.mode.safeParse('mutating').success).toBe(true);
    expect(shell.async.safeParse(true).success).toBe(true);
    const list = tool('forge_process_list').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(list.process_id.safeParse('proc_abc').success).toBe(true);
  });

  it('edits whole files and deletes by null content', () => {
    const edit = tool('forge_edit');
    const schema = edit.inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    // A delete is an edit with no content — not a separate tool to choose between.
    expect(schema.files.safeParse([{ path: 'src/a.ts', content: 'x' }]).success).toBe(true);
    expect(schema.files.safeParse([{ path: 'src/a.ts', content: null }]).success).toBe(true);
    expect(schema.files.safeParse([]).success).toBe(false);
  });

  it('folds interactive steps into forge_preview (no separate browser tools)', () => {
    expect(forgeTools.find((t) => t.name === 'forge_browser_act')).toBeUndefined();
    expect(forgeTools.find((t) => t.name === 'forge_browser_screenshot')).toBeUndefined();
    expect(forgeTools.find((t) => t.name === 'forge_browser_accessibility_tree')).toBeUndefined();

    const capture = tool('forge_preview');
    expect(capture.sideEffect).toBe('workspace');
    const captures = (capture.inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>).captures;
    expect(captures.safeParse([{ route: '/' }]).success).toBe(true);
    expect(captures.safeParse([{ route: '/', steps: [{ kind: 'click', selector: '#add-to-cart' }] }]).success).toBe(true);
    expect(captures.safeParse([{ route: '/', steps: [{ kind: 'not_a_real_action' }] }]).success).toBe(false);
    expect(toolAnnotations('forge_preview', 'workspace')).toMatchObject({ readOnlyHint: false });
  });
});
