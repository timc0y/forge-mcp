import { serialiseBounded } from './tool-call-log';

const MAX_JSON_BODY_BYTES = 64_000;
const SENSITIVE_PATH = /\/(?:oauth|login\/github|github\/(?:setup|reconnect)|app\/secrets|git)\b/iu;

function requestId(): string {
  return `req_${crypto.randomUUID().replace(/-/gu, '').slice(0, 24)}`;
}

function safeHeader(source: { headers: Headers }, name: string): string | undefined {
  const value = source.headers.get(name)?.trim();
  return value ? value.slice(0, 200) : undefined;
}

async function boundedText(body: ReadableStream<Uint8Array> | null): Promise<string | '[omitted:body-too-large]' | undefined> {
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BODY_BYTES) {
        void reader.cancel();
        return '[omitted:body-too-large]';
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function requestBody(request: Request, pathname: string): Promise<unknown> {
  if (SENSITIVE_PATH.test(pathname)) return '[omitted:sensitive-route]';
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (!contentType.includes('json') || contentLength > MAX_JSON_BODY_BYTES) return undefined;
  try {
    const text = await boundedText(request.clone().body);
    if (text === '[omitted:body-too-large]') return text;
    if (!text) return undefined;
    return JSON.parse(text);
  } catch {
    return '[omitted:unparseable-json]';
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (!contentType.includes('json') || contentLength > MAX_JSON_BODY_BYTES) return undefined;
  try {
    const text = await boundedText(response.clone().body);
    if (text === '[omitted:body-too-large]') return text;
    if (!text) return undefined;
    return text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    return '[omitted:unparseable-json]';
  }
}

export interface RequestLogEvent {
  requestId: string;
  method: string;
  pathname: string;
  queryKeys: string[];
  contentType?: string;
  contentLength?: number;
  userAgent?: string;
  body?: unknown;
  status?: number;
  responseContentType?: string;
  responseContentLength?: number;
  responseBody?: unknown;
  durationMs?: number;
  errorName?: string;
}

function log(event: RequestLogEvent, kind: 'request' | 'response'): void {
  const payload = { event: `forge_${kind}`, ...event };
  // Cloudflare Workers captures structured console events. Keep the event name
  // as a stable field so tailing, log drains, and JSON queries can share one
  // filter across production and local development.
  // Apply the same key-based redaction and hard payload ceiling used by the
  // durable tool-call trail before anything reaches the platform log sink.
  const bounded = serialiseBounded(payload).json;
  try {
    console.log(JSON.parse(bounded));
  } catch {
    // A hard-truncated JSON envelope is still safe and useful in a log drain;
    // keep the stable event/request identifiers queryable beside the preview.
    console.log({
      event: `forge_${kind}`,
      requestId: event.requestId,
      payload: bounded
    });
  }
}

export async function withRequestLogging(
  request: Request,
  dispatch: (requestId: string) => Promise<Response>
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const id = requestId();
  const input: RequestLogEvent = {
    requestId: id,
    method: request.method,
    pathname: url.pathname,
    queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
    contentType: safeHeader(request, 'content-type'),
    contentLength: Number(request.headers.get('content-length') ?? 0) || undefined,
    userAgent: safeHeader(request, 'user-agent'),
    body: await requestBody(request, url.pathname)
  };
  log(input, 'request');

  try {
    const response = await dispatch(id);
    const output: RequestLogEvent = {
      requestId: id,
      method: request.method,
      pathname: url.pathname,
      queryKeys: input.queryKeys,
      status: response.status,
      responseContentType: safeHeader(response, 'content-type'),
      responseContentLength: Number(response.headers.get('content-length') ?? 0) || undefined,
      responseBody: await responseBody(response),
      durationMs: Date.now() - startedAt
    };
    log(output, 'response');
    const headers = new Headers(response.headers);
    headers.set('x-forge-request-id', id);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    log({
      requestId: id,
      method: request.method,
      pathname: url.pathname,
      queryKeys: input.queryKeys,
      status: 500,
      durationMs: Date.now() - startedAt,
      errorName: error instanceof Error ? error.name : 'unknown'
    }, 'response');
    throw error;
  }
}

/** Used by tests and diagnostics to prove log payloads obey the same bounds. */
export function serialiseRequestLog(event: RequestLogEvent): string {
  return serialiseBounded(event).json;
}
