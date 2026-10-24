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
    env: { METADATA: metadata, FORGE_CAPTURE_ALLOWED_LOGINS: 'ordinary', FORGE_CAPTURE_DAILY_LIMIT: String(limit), CLOUDFLARE_ACCOUNT_ID: 'synthetic', CLOUDFLARE_API_TOKEN: 'synthetic' } as unknown as Env,
    identity: { userId: 'synthetic', githubLogin: 'ordinary' },
    track: () => {},
    gh: async () => { throw new Error('Unexpected GitHub request'); },
    ghUser: async () => { throw new Error('Unexpected GitHub request'); }
  };
  return { ctx, used: () => used };
}

afterEach(() => vi.unstubAllGlobals());

describe('capture spending ceiling', () => {
  it('refuses unenabled accounts before quota or browser spending', async () => {
    const { ctx, used } = context();
    ctx.env.FORGE_CAPTURE_ALLOWED_LOGINS = 'operator';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(captureResult(ctx, 'https://example.com/', ['desktop'])).rejects.toMatchObject({ code: 'FORGE_AUTH_REQUIRED' });
    expect(used()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    delete ctx.env.FORGE_CAPTURE_ALLOWED_LOGINS;
    await expect(captureResult(ctx, 'https://example.com/', ['desktop'])).rejects.toMatchObject({ code: 'FORGE_AUTH_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([403, 404, 500])('discloses target HTTP %s even when the snapshot API succeeds', async (status) => {
    const { ctx, used } = context();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result: { screenshot: 'iVBORw==', accessibilityTree: {} }, meta: { status } })));
    const result = await captureResult(ctx, 'https://example.com/', ['desktop']);
    expect(result.summary).toContain(`HTTP ${status}`);
    if (status === 403) expect(result.summary).toContain('denial page');
    expect(result.structured.limits).toEqual(expect.arrayContaining([expect.stringContaining('the requested page did not load successfully')]));
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
    expect(used()).toBe(1);
  });

  it('reports the failed viewport when another viewport reached a successful page', async () => {
    const { ctx } = context();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result: { screenshot: 'iVBORw==', accessibilityTree: {} }, meta: { status: calls++ === 0 ? 403 : 200 } })));
    const result = await captureResult(ctx, 'https://example.com/', ['phone', 'desktop']);
    expect(result.summary).toContain('HTTP 403 denial page at phone');
    expect(result.structured.page).toMatchObject({ shown: ['phone', 'desktop'] });
    expect(result.structured.limits).not.toEqual(expect.arrayContaining([expect.stringContaining('desktop: captured an HTTP')]));
  });

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
