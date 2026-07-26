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
  it('does not expose unimplemented workspace options or self-declared approval', () => {
    const create = tool('forge_workspace_create').inputSchema as Record<string, unknown>;
    expect(create).not.toHaveProperty('start_preview');
    expect(Object.keys(create)).toContain('persistence');
    const persistence = create.persistence as { safeParse(value: unknown): { success: boolean } };
    expect(persistence.safeParse('ephemeral').success).toBe(true);
    expect(persistence.safeParse('persistent').success).toBe(false);
    const shell = tool('forge_shell_exec').inputSchema as Record<string, unknown>;
    expect(shell).not.toHaveProperty('approved');
    expect(shell).toHaveProperty('approval_id');
  });

  it('advertises no ui:// widget on any tool, so hosts render plain results', () => {
    // Forge serves no MCP Apps resource. If a `ui` or `openai/outputTemplate`
    // key ever reappears in a tool's _meta, ChatGPT starts rendering a custom
    // component again — which is exactly what was removed. The only
    // Forge-authored UI is the hosted approval page at /approvals/:id.
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
      // The short invoking/invoked status strings are plain text and stay.
      for (const key of Object.keys(meta)) {
        expect(key).toMatch(/^openai\/toolInvocation\//);
      }
    }
  });

  it('marks only retry-safe tools idempotent and true reads read-only', () => {
    expect(toolAnnotations('forge_review', 'none')).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(toolAnnotations('forge_pull_request_create', 'external')).toMatchObject({ idempotentHint: false });
    expect(toolAnnotations('forge_browser_screenshot', 'workspace')).toMatchObject({ idempotentHint: false });
    expect(toolAnnotations('forge_files_read', 'none')).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(toolAnnotations('forge_workspace_create', 'workspace')).toMatchObject({ idempotentHint: true });
    expect(toolAnnotations('forge_files_write', 'workspace')).toMatchObject({ idempotentHint: true });
  });

  it('exposes credential profiles without exposing raw credential fields', () => {
    for (const name of ['forge_credential_list', 'forge_credential_create', 'forge_credential_update', 'forge_credential_delete', 'forge_credential_switch', 'forge_credential_validate']) {
      expect(forgeTools.some((candidate) => candidate.name === name)).toBe(true);
    }
    const create = tool('forge_credential_create').inputSchema as Record<string, unknown>;
    expect(create).toHaveProperty('secret');
    expect(create).toHaveProperty('metadata');
    expect(forgeTools.some((candidate) => candidate.name === 'forge_workspace_reconcile')).toBe(true);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_workspace_prove')).toBe(true);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_workspace_checkpoint')).toBe(true);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_workspace_restore')).toBe(true);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_work_export')).toBe(true);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_files_write')).toBe(true);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_process_stop')).toBe(true);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_check_cancel')).toBe(true);
    expect(forgeTools.some((candidate) => candidate.name === 'forge_cloudflare_deploy')).toBe(true);
  });

  it('exposes all 6 secret vault tools in the tool catalog', () => {
    const expected = ['forge_secret_list', 'forge_secret_create', 'forge_secret_update', 'forge_secret_delete', 'forge_secret_attach', 'forge_secret_detach'];
    for (const name of expected) {
      expect(forgeTools.some((candidate) => candidate.name === name)).toBe(true);
    }
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

  it('forge_secret_attach requires a valid secret_id and workspace_id', () => {
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

  it('forge_secret_detach validates secret_id and workspace_id', () => {
    const schema = tool('forge_secret_detach').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(schema.secret_id.safeParse('sec_00000000000000000000000000').success).toBe(true);
    expect(schema.workspace_id.safeParse(undefined).success).toBe(true);
  });

  it('exposes a full-file write tool and multi-file read for headless agents', () => {
    const write = tool('forge_files_write');
    expect(write.sideEffect).toBe('workspace');
    const writeSchema = write.inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    // expected_sha256 is optional (create vs conflict-safe overwrite).
    expect(writeSchema.expected_sha256.safeParse(undefined).success).toBe(true);
    expect(writeSchema.expected_sha256.safeParse('a'.repeat(64)).success).toBe(true);
    expect(writeSchema.expected_sha256.safeParse('nothex').success).toBe(false);
    expect(writeSchema.path.safeParse('/workspace/repo/src/new.ts').success).toBe(true);
    // A write mutates, so it must be non-idempotent unless replayed with a key.
    expect(toolAnnotations('forge_files_write', 'none')).toMatchObject({ readOnlyHint: false });

    const readSchema = tool('forge_files_read').inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    expect(readSchema.paths.safeParse(['/workspace/a', '/workspace/b']).success).toBe(true);
    expect(readSchema.paths.safeParse([]).success).toBe(false);
  });

  it('folds interactive steps into forge_review_capture (no separate browser tools)', () => {
    // The standalone screenshot/accessibility/act tools were collapsed into one.
    expect(forgeTools.find((t) => t.name === 'forge_browser_act')).toBeUndefined();
    expect(forgeTools.find((t) => t.name === 'forge_browser_screenshot')).toBeUndefined();
    expect(forgeTools.find((t) => t.name === 'forge_browser_accessibility_tree')).toBeUndefined();

    const capture = tool('forge_review_capture');
    expect(capture.sideEffect).toBe('workspace');
    const captures = (capture.inputSchema as Record<string, { safeParse(value: unknown): { success: boolean } }>).captures;
    // A plain capture works, and an optional steps array drives an interaction.
    expect(captures.safeParse([{ route: '/' }]).success).toBe(true);
    expect(captures.safeParse([{ route: '/', steps: [{ kind: 'click', selector: '#add-to-cart' }] }]).success).toBe(true);
    expect(captures.safeParse([{ route: '/', steps: [{ kind: 'not_a_real_action' }] }]).success).toBe(false);
    // Capture mutates the workspace and is not silently replayed.
    expect(toolAnnotations('forge_review_capture', 'workspace')).toMatchObject({ readOnlyHint: false });
  });
});
