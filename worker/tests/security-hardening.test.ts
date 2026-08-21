import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { capture } from '../src/capture';
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

  it('does not relay unexpected exception text to callers', () => {
    const error = toForgeError(new Error('secret=should-never-be-public'));
    expect(error.message).not.toContain('should-never-be-public');
    expect(error.code).toBe('FORGE_UPSTREAM_UNAVAILABLE');
  });
});
