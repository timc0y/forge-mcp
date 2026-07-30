import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../apps/forge-edge-gateway/src/env';
import { workspaceOperations } from '../../apps/forge-edge-gateway/src/workspace-operations';

const GATEWAY = new URL('../../apps/forge-edge-gateway/src/', import.meta.url);
const callerSource = ['index.ts', 'observer-api.ts', 'workflows.ts']
  .map((file) => readFileSync(new URL(file, GATEWAY), 'utf8'))
  .join('\n');

describe('workspace operations boundary', () => {
  it('is the only caller-side module that knows the Durable Object lookup transport', () => {
    expect(callerSource).not.toContain('WORKSPACE_COORDINATORS.get');
    expect(callerSource).not.toContain('WORKSPACE_COORDINATORS.idFromName');
    expect(callerSource).not.toMatch(/WorkspaceCoordinator\s*\[/u);
  });

  it('adapts a workspace id to the existing RPC object without wrapping methods', () => {
    const operations = { getState: vi.fn() };
    const idFromName = vi.fn(() => ({ id: 'durable-id' }));
    const get = vi.fn(() => operations);
    const env = {
      WORKSPACE_COORDINATORS: { idFromName, get }
    } as unknown as Env;

    expect(workspaceOperations(env, 'ws_test')).toBe(operations);
    expect(idFromName).toHaveBeenCalledExactlyOnceWith('ws_test');
    expect(get).toHaveBeenCalledExactlyOnceWith({ id: 'durable-id' });
  });
});
