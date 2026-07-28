import { describe, expect, it } from 'vitest';
import { forgeTools } from '@forge/mcp-core';
import { toolAnnotations } from '../../packages/mcp-adapter-v1/src/index';

const tool = forgeTools.find((entry) => entry.name === 'forge_branches')!;

describe('forge_branches', () => {
  it('is declared as an external side effect, never a read', () => {
    // It deletes refs on GitHub. Advertising readOnlyHint would tell a host it
    // is safe to call speculatively or retry freely.
    expect(tool.sideEffect).toBe('external');
    expect(toolAnnotations('forge_branches', 'external')).toMatchObject({ readOnlyHint: false });
  });

  it('defaults to listing, so a bare call cannot delete anything', () => {
    const schema = tool.inputSchema as Record<string, { parse(value: unknown): unknown }>;
    expect(schema.action.parse(undefined)).toBe('list');
    expect(schema.merged_only.parse(undefined)).toBe(false);
    expect(schema.force.parse(undefined)).toBe(false);
  });

  it('reports merged status per branch so deletion is never guessed', () => {
    const out = tool.outputSchema as Record<string, unknown>;
    expect(Object.keys(out)).toContain('branches');
    expect(Object.keys(out)).toContain('refused');
  });
});
