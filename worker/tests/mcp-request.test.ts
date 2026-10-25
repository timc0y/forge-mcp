import { describe, expect, it, vi } from 'vitest';
import { boundedMcpRequest } from '../src/mcp-request';

const limit = 4 * 1024 * 1024;

function streamed(sizes: number[], declared?: string) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of sizes) controller.enqueue(new Uint8Array(size).fill(32));
      controller.close();
    }, cancel
  });
  const request = new Request('https://example.test/mcp', {
    method: 'POST', body, duplex: 'half', headers: declared ? { 'content-length': declared } : {}
  } as RequestInit);
  return { request, cancel };
}

describe('MCP request byte boundary before JSON parsing', () => {
  it.each([undefined, '1'])('rejects an oversized stream regardless of declared length (%s)', async declared => {
    const { request } = streamed([limit, 1], declared);
    expect(await boundedMcpRequest(request)).toBeNull();
  });

  it('refuses an oversized declared body before reading it', async () => {
    const { request } = streamed([1], String(limit + 1));
    expect(await boundedMcpRequest(request)).toBeNull();
    expect(request.bodyUsed).toBe(false);
  });

  it('preserves a body at the boundary and forwards its actual byte count', async () => {
    const { request } = streamed([limit / 2, limit / 2], '1');
    const bounded = await boundedMcpRequest(request);
    expect(bounded?.headers.get('content-length')).toBe(String(limit));
    expect((await bounded?.arrayBuffer())?.byteLength).toBe(limit);
  });

  it('preserves UTF-8 bytes and authentication headers', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { text: '你好' } });
    const bounded = await boundedMcpRequest(new Request('https://example.test/mcp', {
      method: 'POST', body, headers: { authorization: 'Bearer synthetic' }
    }));
    expect(bounded?.headers.get('authorization')).toBe('Bearer synthetic');
    expect(bounded?.headers.get('content-length')).toBe(String(new TextEncoder().encode(body).length));
    expect(await bounded?.text()).toBe(body);
  });

  it('leaves GET event streams untouched', async () => {
    const request = new Request('https://example.test/mcp');
    expect(await boundedMcpRequest(request)).toBe(request);
  });
});
