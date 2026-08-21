import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { capture } from '../src/capture';
import { approvalPage } from '../src/approve';
import { toForgeError } from '../src/errors';

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureEnv(): Env {
  return {
    CLOUDFLARE_ACCOUNT_ID: 'account',
    CLOUDFLARE_API_TOKEN: 'browser-token'
  } as unknown as Env;
}

describe('public exposure hardening', () => {
  it('renders a duplicated viewport only once and sends redirect guards', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        success: true,
        result: {
          screenshot: btoa('png'),
          accessibilityTree: { role: 'RootWebArea', name: 'Example' }
        },
        meta: { title: 'Example' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await capture(captureEnv(), 'https://example.com/', ['desktop', 'desktop', 'desktop']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.images).toHaveLength(1);
    expect(calls[0]?.rejectRequestPattern).toEqual(expect.arrayContaining([expect.stringContaining('localhost')]));
  });

  it('refuses more than three viewport requests before spending browser time', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      capture(captureEnv(), 'https://example.com/', ['phone', 'tablet', 'desktop', 'desktop'])
    ).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps approval form posts on the current mounted path', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const signingKey = 'test-signing-key-that-is-at-least-32-bytes';
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(signingKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(id))
    );
    let binary = '';
    for (const byte of signature) binary += String.fromCharCode(byte);
    const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const row = {
      id,
      user_id: 'user-1',
      act: 'merge',
      repo_owner: 'octocat',
      repo_name: 'hello-world',
      branch: 'forge/test',
      head_sha: '0123456789abcdef',
      evidence_json: JSON.stringify({
        change: {
          name: 'test',
          branch: 'forge/test',
          number: 1,
          draft: true,
          updatedAt: '2026-08-21T00:00:00.000Z'
        },
        comparison: {
          status: 'ahead',
          aheadBy: 1,
          behindBy: 0,
          files: [],
          truncated: false
        },
        baseBranch: 'main'
      }),
      state: 'pending',
      result_json: null,
      created_at: '2026-08-21T00:00:00.000Z',
      expires_at: '2099-08-21T00:00:00.000Z',
      resolved_at: null
    };
    const metadata = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return row;
              }
            };
          }
        };
      }
    };
    const env = {
      METADATA: metadata,
      FORGE_SIGNING_KEY: signingKey
    } as unknown as Env;

    const response = await approvalPage(env, id, token);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<form method="post" action="?t=');
    expect(html).not.toContain('action="/approvals/');
  });

  it('does not relay unexpected exception text to callers', () => {
    const error = toForgeError(new Error('secret=should-never-be-public'));
    expect(error.message).not.toContain('should-never-be-public');
    expect(error.code).toBe('FORGE_UPSTREAM_UNAVAILABLE');
  });
});
