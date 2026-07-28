import { describe, expect, it } from 'vitest';
import { forgeTools, REMOVED_TOOLS } from '@forge/mcp-core';

describe('removed tools', () => {
  it('never shadows a live tool', () => {
    // A tombstone that collides with a real name would make the real tool
    // unreachable — the failure would be total and silent.
    const live = new Set(forgeTools.map((t) => t.name));
    for (const name of Object.keys(REMOVED_TOOLS)) {
      expect(live.has(name), name).toBe(false);
    }
  });

  it('covers every name this redesign deleted', () => {
    // Any deleted name missing here yields a bare -32602 for stale clients,
    // which is the retry storm the removal was supposed to end.
    const mustExplain = [
      'forge_files_write', 'forge_files_write_batch', 'forge_files_replace', 'forge_files_patch',
      'forge_files_upload', 'forge_git_status', 'forge_git_diff', 'forge_git_branch',
      'forge_git_commit', 'forge_git_push', 'forge_git_sync', 'forge_git_rebase',
      'forge_pull_request_create', 'forge_submit', 'forge_work_export', 'forge_doctor',
      'forge_workspace_prove'
    ];
    for (const name of mustExplain) {
      expect(REMOVED_TOOLS[name], name).toBeTruthy();
    }
  });

  it('points every removal at something that exists', () => {
    const live = new Set(forgeTools.map((t) => t.name));
    for (const [name, guidance] of Object.entries(REMOVED_TOOLS)) {
      for (const referenced of guidance.match(/forge_[a-z_]+/gu) ?? []) {
        expect(live.has(referenced), `${name} -> ${referenced}`).toBe(true);
      }
    }
  });
});

import { removedToolCall, removedToolResponse } from '../../apps/forge-edge-gateway/src/removed-tools';

describe('answering a stale client', () => {
  const call = (name: string) =>
    JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: {} } });

  it('recognises a call to a removed tool', () => {
    expect(removedToolCall(call('forge_files_write'))).toEqual({ id: 7, name: 'forge_files_write' });
  });

  it('leaves live tools and other methods alone', () => {
    expect(removedToolCall(call('forge_edit'))).toBeNull();
    expect(removedToolCall(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toBeNull();
    expect(removedToolCall('not json')).toBeNull();
  });

  it('does not swallow a batch containing real work', () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forge_files_write' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'forge_edit' } }
    ]);
    expect(removedToolCall(batch)).toBeNull();
  });

  it('answers with an actionable Forge error, not a protocol error', () => {
    const response = removedToolResponse({ id: 7, name: 'forge_git_push' }) as {
      id: number; result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(response.id).toBe(7);
    expect(response.result.isError).toBe(true);
    const payload = JSON.parse(response.result.content[0]!.text) as { error: { code: string; message: string; details: Record<string, unknown> } };
    expect(payload.error.code).toBe('FORGE_VALIDATION_FAILED');
    // The three things -32602 fails to say.
    expect(payload.error.message).toMatch(/no longer exists/u);
    expect(payload.error.message).toMatch(/reconnect/iu);
    expect(payload.error.message).toMatch(/do not try the other/iu);
    expect(payload.error.details.action).toBe('reconnect_to_refresh_tools');
  });
});
