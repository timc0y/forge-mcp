/** Bound actual bytes before the Agents transport parses JSON or creates a session. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export async function boundedMcpRequest(request: Request): Promise<Request | null> {
  return boundedRequest(request, MAX_REQUEST_BYTES);
}

/** Bound actual streamed bytes, including requests with misleading Content-Length. */
export async function boundedRequest(request: Request, maxBytes: number): Promise<Request | null> {
  if (request.method !== 'POST' || !request.body) return request;
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) return null;

  const reader = request.body.getReader();
  let body = new Uint8Array(1024);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const nextSize = size + chunk.value.byteLength;
      if (nextSize > maxBytes) {
        void reader.cancel().catch(() => {});
        return null;
      }
      if (nextSize > body.byteLength) {
        const expanded = new Uint8Array(Math.min(maxBytes, Math.max(nextSize, body.byteLength * 2)));
        expanded.set(body.subarray(0, size));
        body = expanded;
      }
      body.set(chunk.value, size);
      size = nextSize;
    }
  } finally {
    reader.releaseLock();
  }
  const headers = new Headers(request.headers);
  headers.set('content-length', String(size));
  return new Request(request, { headers, body: body.subarray(0, size) });
}
