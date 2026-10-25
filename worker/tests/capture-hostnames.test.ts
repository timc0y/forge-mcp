import { afterEach, describe, expect, it, vi } from 'vitest';
import { capture, validateCaptureRequest } from '../src/capture';
import type { Env } from '../src/env';

afterEach(() => vi.unstubAllGlobals());

describe('capture request userinfo', () => {
  it.each(['localhost', 'metadata.google.internal', '127.0.0.1', 'example.com'])('rejects credentials on %s before provider work', async (hostname) => {
    const fetch = vi.fn(async () => { throw new Error('Unexpected capture provider request'); });
    vi.stubGlobal('fetch', fetch);
    for (const scheme of ['http', 'https']) {
      for (const userinfo of ['u:p', 'u', ':p', 'u%40name:p%40ss']) {
        const url = `${scheme}://${userinfo}@${hostname}/`;
        await expect(capture({} as Env, url, ['desktop']), url).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('supplies a userinfo deny pattern bounded to the request authority', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ success: true, result: { screenshot: 'iVBORw==', accessibilityTree: {} } }));
    vi.stubGlobal('fetch', fetch);
    await capture({ CLOUDFLARE_ACCOUNT_ID: 'synthetic', CLOUDFLARE_API_TOKEN: 'synthetic' } as Env, 'https://example.com/', ['desktop']);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const patterns = (body.rejectRequestPattern as string[]).map((pattern) => new RegExp(pattern));
    const blocked = (url: string) => patterns.some((pattern) => pattern.test(url));
    for (const hostname of ['localhost', 'metadata.google.internal', '127.0.0.1', 'example.com']) {
      for (const scheme of ['http', 'https']) {
        for (const userinfo of ['u:p', 'u', ':p', 'u%40name:p%40ss']) {
          const url = `${scheme}://${userinfo}@${hostname}/`;
          expect(blocked(url), url).toBe(true);
        }
      }
    }
    for (const url of [
      'https://example.com/@u:p@localhost/',
      'https://example.com?user=u:p@localhost',
      'https://example.com#u:p@metadata.google.internal',
      'https://example.com:8443/path?user=u:p@127.0.0.1#@localhost'
    ]) {
      expect(blocked(url), url).toBe(false);
    }
  });
});

describe('terminal-dot capture hostnames', () => {
  it.each(['localhost', 'service.localhost', 'service.local', '127.0.0.1'])('rejects %s with zero, one or repeated terminal dots before provider work', async (hostname) => {
    const fetch = vi.fn(async () => { throw new Error('Unexpected capture provider request'); });
    vi.stubGlobal('fetch', fetch);
    for (const dot of ['', '.', '..', '...', '....']) {
      for (const url of [`https://${hostname}${dot}/`, `http://${hostname}${dot}:8080/path`]) {
        await expect(capture({} as Env, url, ['desktop']), url).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['example.com', 'metadata.google.internal'])('rejects repeated terminal dots on %s before provider work', async (hostname) => {
    const fetch = vi.fn(async () => { throw new Error('Unexpected capture provider request'); });
    vi.stubGlobal('fetch', fetch);
    for (const dot of ['..', '...', '....', '.%2e', '%2e%2e']) {
      const url = `https://${hostname}${dot}/`;
      expect(() => validateCaptureRequest(url, ['desktop']), url).toThrow(expect.objectContaining({ code: 'FORGE_VALIDATION_FAILED' }));
      await expect(capture({} as Env, url, ['desktop']), url).rejects.toMatchObject({ code: 'FORGE_VALIDATION_FAILED' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['Example.COM', 'Example.COM.'])('uses the same canonical public URL for validation and the mocked provider for %s', async (hostname) => {
    const raw = `https://${hostname}:8443/path?query=value#section`;
    const canonical = 'https://example.com:8443/path?query=value#section';
    expect(validateCaptureRequest(raw, ['desktop']).target.href).toBe(canonical);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ success: true, result: { screenshot: 'iVBORw==', accessibilityTree: {} } }));
    vi.stubGlobal('fetch', fetch);
    await capture({ CLOUDFLARE_ACCOUNT_ID: 'synthetic', CLOUDFLARE_API_TOKEN: 'synthetic' } as Env, raw, ['desktop']);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.url).toBe(canonical);
  });

  it('supplies deny patterns for zero, one or repeated terminal dots on redirects and subrequests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ success: true, result: { screenshot: 'iVBORw==', accessibilityTree: {} } }));
    vi.stubGlobal('fetch', fetch);
    await capture({ CLOUDFLARE_ACCOUNT_ID: 'synthetic', CLOUDFLARE_API_TOKEN: 'synthetic' } as Env, 'https://example.com/', ['desktop']);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const patterns = (body.rejectRequestPattern as string[]).map((pattern) => new RegExp(pattern));
    const blocked = (url: string) => patterns.some((pattern) => pattern.test(url));
    for (const hostname of ['localhost', 'service.localhost', 'service.local', 'metadata.google.internal', '127.0.0.1', '10.1.2.3', '192.168.1.2', '169.254.169.254', '172.16.1.2', '172.31.1.2']) {
      for (const dot of ['', '.', '..', '...', '....']) {
        for (const scheme of ['http', 'https']) {
          for (const ending of ['', '/path', ':8080/path']) {
            const url = `${scheme}://${hostname}${dot}${ending}`;
            expect(blocked(url), url).toBe(true);
          }
        }
      }
    }
    for (const url of ['https://example.com/', 'https://localhost.example.com/', 'https://metadata.google.internal.example.com/', 'https://service.local.example.com/', 'https://example.com./', 'https://localhost.example.com./', 'https://metadata.google.internal.example.com./', 'https://service.local.example.com./']) {
      expect(blocked(url), url).toBe(false);
    }
  });
});
