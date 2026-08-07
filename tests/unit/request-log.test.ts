import { afterEach, describe, expect, it, vi } from 'vitest';
import { serialiseRequestLog, withRequestLogging } from '../../apps/forge-edge-gateway/src/request-log';

describe('HTTP request/response logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs bounded request and response summaries and returns a correlation header', async () => {
    const events: unknown[] = [];
    vi.spyOn(console, 'log').mockImplementation((event) => events.push(event));

    const response = await withRequestLogging(
      new Request('https://forge.test/health?probe=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '41' },
        body: JSON.stringify({ command: 'health', token: 'never-store-this' })
      }),
      async () => Response.json({ ok: true, result: 'healthy' })
    );

    const requestEvent = events[0] as Record<string, unknown>;
    const responseEvent = events[1] as Record<string, unknown>;
    expect(requestEvent.event).toBe('forge_request');
    expect(responseEvent.event).toBe('forge_response');
    expect(requestEvent.requestId).toBe(responseEvent.requestId);
    expect(requestEvent.body).toEqual({ command: 'health', token: '[redacted]' });
    expect(responseEvent.responseBody).toEqual({ ok: true, result: 'healthy' });
    expect(response.headers.get('x-forge-request-id')).toMatch(/^req_[a-f0-9]{24}$/u);
  });

  it('omits OAuth and credential-route bodies', async () => {
    const events: unknown[] = [];
    vi.spyOn(console, 'log').mockImplementation((event) => events.push(event));

    await withRequestLogging(
      new Request('https://forge.test/oauth/token?code=one', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'secret', refresh_token: 'secret' })
      }),
      async () => Response.json({ access_token: 'also-secret' })
    );

    expect((events[0] as Record<string, unknown>).body).toBe('[omitted:sensitive-route]');
    expect((events[1] as Record<string, unknown>).responseBody).toEqual({ access_token: '[redacted]' });
    expect(JSON.stringify(events)).not.toContain('secret');
  });

  it('keeps serialized log events bounded', () => {
    const serialized = serialiseRequestLog({
      requestId: 'req_test',
      method: 'POST',
      pathname: '/mcp',
      queryKeys: [],
      body: { content: 'x'.repeat(100_000) }
    });
    expect(serialized.length).toBeLessThanOrEqual(8_020);
    expect(serialized).toContain('100000 chars total');
  });

  it('does not read an unbounded chunked JSON body into the log', async () => {
    const events: unknown[] = [];
    vi.spyOn(console, 'log').mockImplementation((event) => events.push(event));

    await withRequestLogging(
      new Request('https://forge.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x'.repeat(70_000) })
      }),
      async () => new Response(JSON.stringify({ content: 'y'.repeat(70_000) }), {
        headers: { 'content-type': 'application/json' }
      })
    );

    expect((events[0] as Record<string, unknown>).body).toBe('[omitted:body-too-large]');
    expect((events[1] as Record<string, unknown>).responseBody).toBe('[omitted:body-too-large]');
  });
});
