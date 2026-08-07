import { describe, expect, it } from 'vitest';
import type { Env } from '../../apps/forge-edge-gateway/src/env';
import { directChatHandlers, type DirectChatPrivateOperations } from '../../apps/forge-edge-gateway/src/handlers/direct-chat';

const identity = () => ({ subject: 'user', tenantId: 'tenant', projectId: 'project', clientId: 'chatgpt' });
const repository = { owner: 'acme', repo: 'web' };

function handlers(overrides: Partial<DirectChatPrivateOperations> = {}) {
  const privateOperations: DirectChatPrivateOperations = {
    run: async () => ({ exitCode: 0, result_summary: 'tests passed' }),
    screenshot: async () => ({ complete: true, evidence: [] }),
    environments: async () => ({ environments: [] }),
    deploy: async () => ({ approval_url: 'https://forge.test/approvals/apr_1' }),
    submit: async () => ({ approval_url: 'https://forge.test/approvals/apr_2' }),
    ...overrides
  };
  return directChatHandlers({} as Env, { identity, privateOperations });
}

describe('direct chat facade', () => {
  it('makes command filesystem state explicitly ephemeral', async () => {
    const result = await handlers().run({ repository, ref: 'forge/chat-1', command: 'pnpm test' });

    expect(result.state).toBe('completed');
    expect(result.remote_persisted).toBe(false);
    expect(result.executor_filesystem).toBe('ephemeral');
    expect(result.next_action).toBe('none');
  });

  it('does not tell chat to poll a running command or expose a process id requirement', async () => {
    let observedTimeout = 0;
    const result = await handlers({ run: async (input) => {
      observedTimeout = input.timeoutMs;
      return { status: 'running', status_url: 'https://forge.test/status/op_1', process_id: 'proc_private' };
    } })
      .run({ repository, ref: 'forge/chat-1', command: 'pnpm build', timeoutMs: 90_000 });

    expect(observedTimeout).toBe(90_000);
    expect(result.state).toBe('running');
    expect(result.next_action).toEqual({ kind: 'human', message: 'Open the returned status URL for the final result.' });
    expect(result).toMatchObject({ status_url: 'https://forge.test/status/op_1' });
    expect(result).not.toHaveProperty('process_id');
  });

  it('returns deferred deploy approval as a terminal chat receipt', async () => {
    const result = await handlers().deploy({ repository, ref: 'forge/chat-1', environment: 'preview' });

    expect(result.state).toBe('approval_required');
    expect(result.repository_ref).toBe('acme/web#forge/chat-1');
    expect(result.next_action.kind).toBe('human');
    expect(result.next_action.message).toMatch(/without another chat call/u);
  });

  it('keeps screenshot images on the initiating call', async () => {
    const result = await handlers({
      screenshot: async () => ({
        kind: 'forge_tool_response' as const,
        value: { complete: true, gallery_url: 'https://forge.test/gallery/signed' },
        content: [{ type: 'image' as const, data: 'encoded-image', mimeType: 'image/jpeg' }]
      })
    }).screenshot({
      target: { url: 'https://example.com' },
      viewports: ['phone', 'desktop']
    });

    expect(result).toMatchObject({ kind: 'forge_tool_response', value: { state: 'completed' } });
    expect(result).toHaveProperty('content', [{ type: 'image', data: 'encoded-image', mimeType: 'image/jpeg' }]);
  });

  it('keeps private preview recovery choreography out of direct-chat errors', async () => {
    await expect(handlers({
      screenshot: async () => {
        throw {
          code: 'FORGE_PREVIEW_UNAVAILABLE',
          message: 'No dev server command was detected. Call forge_deps_install then forge_process_wait, or use forge_shell.',
          retryable: true
        };
      }
    }).screenshot({ target: { repository, ref: 'forge/chat-1' } })).rejects.toMatchObject({
      code: 'FORGE_PREVIEW_UNAVAILABLE',
      message: expect.stringContaining('forge.json'),
      details: { allowedNextActions: ['forge_edit', 'forge_screenshot'] }
    });
  });

  it('returns a repair action for an invalid repository preview config', async () => {
    await expect(handlers({
      screenshot: async () => {
        throw {
          code: 'FORGE_PREVIEW_UNAVAILABLE',
          message: 'Forge config preview.port must be an integer from 1024 to 65535.',
          retryable: false
        };
      }
    }).screenshot({ target: { repository, ref: 'forge/chat-1' } })).rejects.toMatchObject({
      code: 'FORGE_PREVIEW_UNAVAILABLE',
      message: expect.stringContaining('correct the repo-root'),
      details: { allowedNextActions: ['forge_edit', 'forge_screenshot'] }
    });
  });

  it('treats status as observational when no operation registry has a match', async () => {
    const result = await handlers().status('acme/web#forge/chat-1');

    expect(result.state).toBe('completed');
    expect(result.next_action).toBe('none');
  });
});
