import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';

const calls = vi.hoisted(() => ({ page: vi.fn(), resolve: vi.fn(), credential: vi.fn() }));
vi.mock('../src/mcp', () => ({ SERVER_VERSION: '2.2.0', ForgeMcpSession: {} }));
vi.mock('../src/approve', () => ({ approvalPage: calls.page, resolveApproval: calls.resolve }));
vi.mock('../src/user-token', () => ({ userRequestFor: calls.credential }));
import worker from '../src/index';

const url = 'https://example.test/forge/approvals/approval-1?t=signed';
const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;

function environment(login = 'alice') {
  const env = {
    FORGE_PUBLIC_ORIGIN: 'https://example.test/forge',
    FORGE_ALLOWED_LOGINS: 'alice',
    METADATA: { prepare: () => ({ bind: () => ({ first: async () => ({
      user_id: 'owner-id', id: 'owner-id', github_login: login
    }) }) }) }
  } as unknown as Env;
  calls.page.mockImplementation(async (_env, _id, token) => new Response(
    token === 'signed' ? 'review evidence' : 'invalid link', { status: token === 'signed' ? 200 : 404 }
  ));
  calls.resolve.mockImplementation(async (_env, _id, _token, _decision, gh) => {
    await gh('/repos/alice/project');
    return new Response('resolved');
  });
  return env;
}

afterEach(() => vi.resetAllMocks());

describe('private instance approval links', () => {
  it.each(['GET', 'POST'])('conceals a denied owner’s approval on %s without GitHub work', async method => {
    const env = environment('other-person');
    const response = await worker.fetch(new Request(url, {
      method, ...(method === 'POST' ? { body: new URLSearchParams({ decision: 'approve' }) } : {})
    }), env, context);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('invalid link');
    expect(calls.page).toHaveBeenCalledWith(env, 'approval-1', 'invalid');
    expect(calls.resolve).not.toHaveBeenCalled();
    expect(calls.credential).not.toHaveBeenCalled();
  });

  it('retains the owner’s valid review link without resolving credentials', async () => {
    const env = environment();
    const response = await worker.fetch(new Request(url), env, context);
    expect(await response.text()).toBe('review evidence');
    expect(calls.resolve).not.toHaveBeenCalled();
    expect(calls.credential).not.toHaveBeenCalled();
  });

  it('uses the allowed stored owner for an explicit decision', async () => {
    const env = environment();
    const gh = vi.fn(async () => ({ status: 200 }));
    calls.credential.mockResolvedValue(gh);
    const response = await worker.fetch(new Request(url, {
      method: 'POST', body: new URLSearchParams({ decision: 'approve' })
    }), env, context);
    expect(response.status).toBe(200);
    expect(calls.credential).toHaveBeenCalledWith(env, 'owner-id');
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it('rechecks access before GitHub even if it changes after the link lookup', async () => {
    const env = environment();
    calls.resolve.mockImplementation(async (_env, _id, _token, _decision, gh) => {
      env.FORGE_ALLOWED_LOGINS = '';
      await gh('/repos/alice/project');
      return new Response('should not resolve');
    });
    const response = await worker.fetch(new Request(url, {
      method: 'POST', body: new URLSearchParams({ decision: 'approve' })
    }), env, context);
    expect(response.status).toBe(401);
    expect(calls.credential).not.toHaveBeenCalled();
  });
});
