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

  it('treats status as observational when no operation registry has a match', async () => {
    const result = await handlers().status('acme/web#forge/chat-1');

    expect(result.state).toBe('completed');
    expect(result.next_action).toBe('none');
  });
});
