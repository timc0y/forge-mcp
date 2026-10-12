import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureResult } from '../src/capture-result';
import type { ToolContext } from '../src/tool-types';
import type { Env } from '../src/env';

function context(limit = 1): { ctx: ToolContext; used: () => number } {
  let used = 0;
  const metadata = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async run() {
          if (!sql.startsWith('INSERT INTO capture_usage')) throw new Error('Unexpected database mutation');
          if (used >= limit) return { meta: { changes: 0 } };
          used++;
          return { meta: { changes: 1 } };
        },
        async first() { return { count: used }; }
      };
    }
  };
  const ctx: ToolContext = {
    env: { METADATA: metadata, FORGE_CAPTURE_DAILY_LIMIT: String(limit), CLOUDFLARE_ACCOUNT_ID: 'synthetic', CLOUDFLARE_API_TOKEN: 'synthetic' } as unknown as Env,
    identity: { userId: 'synthetic', githubLogin: 'ordinary' },
    track: () => {},
    gh: async () => { throw new Error('Unexpected GitHub request'); },
    ghUser: async () => { throw new Error('Unexpected GitHub request'); }
  };
  return { ctx, used: () => used };
}

afterEach(() => vi.unstubAllGlobals());

describe('capture spending ceiling', () => {
  it('rejects invalid URLs before reserving quota or contacting the provider', async () => {
    const { ctx, used } = context();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(captureResult(ctx, 'http://127.0.0.1/', ['desktop'])).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
    expect(used()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a reservation when successful provider output is too large to read', async () => {
    const { ctx, used } = context();
    const fetch = vi.fn(async () => new Response('{}', { headers: { 'content-length': String(13 * 1024 * 1024), 'x-browser-ms-used': '5000' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(captureResult(ctx, 'https://example.com/', ['desktop'])).rejects.toMatchObject({ code: 'FORGE_UPSTREAM_UNAVAILABLE' });
    expect(used()).toBe(1);
    await expect(captureResult(ctx, 'https://example.com/', ['desktop'])).rejects.toMatchObject({ code: 'FORGE_QUOTA_EXCEEDED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('counts attempts with unknown transport outcomes and successful captures', async () => {
    const { ctx, used } = context(2);
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('Connection lost after browser work'))
      .mockResolvedValueOnce(Response.json({ success: true, result: { screenshot: 'iVBORw==', accessibilityTree: {} } }));
    vi.stubGlobal('fetch', fetch);
    await expect(captureResult(ctx, 'https://example.com/', ['desktop'])).rejects.toMatchObject({ code: 'FORGE_UPSTREAM_UNAVAILABLE' });
    await expect(captureResult(ctx, 'https://example.com/', ['desktop'])).resolves.toMatchObject({ structured: { quota: '2 of 2' } });
    expect(used()).toBe(2);
  });
});
