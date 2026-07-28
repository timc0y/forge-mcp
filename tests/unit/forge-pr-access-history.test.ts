import { describe, expect, it } from 'vitest';
import { forgeTools } from '@forge/mcp-core';
import { toolAnnotations } from '../../packages/mcp-adapter-v1/src/index';

const tool = (name: string) => forgeTools.find((entry) => entry.name === name)!;

describe('forge_pr', () => {
  it('is an external side effect — it can merge', () => {
    expect(tool('forge_pr').sideEffect).toBe('external');
    expect(toolAnnotations('forge_pr', 'external')).toMatchObject({ readOnlyHint: false });
  });

  it('defaults to listing, so a bare call cannot merge anything', () => {
    const schema = tool('forge_pr').inputSchema as Record<string, { parse(value: unknown): unknown }>;
    expect(schema.action.parse(undefined)).toBe('list');
    expect(schema.force.parse(undefined)).toBe(false);
  });

  it('reports blockers and a safe_to_merge verdict rather than a bare state', () => {
    // "mergeable: true" from GitHub says nothing about whether checks passed.
    // The verdict has to fold in checks, draft state and review, or an agent
    // reads one true field and merges on it.
    const out = tool('forge_pr').outputSchema as Record<string, unknown>;
    expect(Object.keys(out)).toContain('status');
    const status = JSON.stringify(out.status);
    expect(status).toContain('safe_to_merge');
    expect(status).toContain('blockers');
  });
});

describe('forge_access and forge_history', () => {
  it('are true reads and annotated as such', () => {
    for (const name of ['forge_access', 'forge_history']) {
      expect(tool(name).sideEffect, name).toBe('none');
      expect(toolAnnotations(name, 'none'), name).toMatchObject({ readOnlyHint: true });
    }
  });

  it('forge_access separates authorized-in-Forge from reachable-now', () => {
    // A repository row saying "authorized" is not proof the App can still read
    // it. Reporting the row would recreate the diagnosis this tool exists to
    // prevent: a permissions failure misread as a broken transport.
    const out = tool('forge_access').outputSchema as Record<string, unknown>;
    for (const field of ['authorized', 'can_read', 'can_write']) {
      expect(Object.keys(out)).toContain(field);
    }
  });
});
