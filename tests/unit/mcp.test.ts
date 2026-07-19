import { describe, expect, it } from 'vitest';
import { forgeTools } from '@forge/mcp-core';
import { toolAnnotations } from '../../packages/mcp-adapter-v1/src/index';

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

  it('marks only retry-safe tools idempotent and true reads read-only', () => {
    expect(toolAnnotations('forge_review', 'none')).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(toolAnnotations('forge_pull_request_create', 'external')).toMatchObject({ idempotentHint: false });
    expect(toolAnnotations('forge_browser_screenshot', 'workspace')).toMatchObject({ idempotentHint: false });
    expect(toolAnnotations('forge_files_read', 'none')).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(toolAnnotations('forge_workspace_create', 'workspace')).toMatchObject({ idempotentHint: true });
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

  it('exposes bounded interactive browser steps that are not retry-safe', () => {
    const act = tool('forge_browser_act');
    expect(act.sideEffect).toBe('workspace');
    const schema = act.inputSchema as Record<string, unknown>;
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining(['workspace_id', 'preview_id', 'steps', 'viewport'])
    );
    const steps = schema.steps as { safeParse(value: unknown): { success: boolean } };
    expect(steps.safeParse([{ kind: 'click', selector: '#add-to-cart' }]).success).toBe(true);
    expect(steps.safeParse([{ kind: 'not_a_real_action' }]).success).toBe(false);
    expect(steps.safeParse([]).success).toBe(false);
    // Interactions are order-dependent side effects, never silently replayed.
    expect(toolAnnotations('forge_browser_act', 'workspace')).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false
    });
  });
});
