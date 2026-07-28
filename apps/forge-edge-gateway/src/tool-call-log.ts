import { ids } from '@forge/core';
import type { Env } from './env';

/**
 * The live record of what agents send and what Forge sends back.
 *
 * Counting failures was never the hard part. Every real failure in this system
 * turned on the *content* of a call — an argument an agent could not have known
 * to send, a response it misread, guidance naming a tool that no longer
 * existed. None of that is visible from a tool name and a status, so it stayed
 * invisible until someone reproduced it by hand.
 *
 * Two rules keep this safe to run in production: secrets never get written, and
 * payloads are bounded. Both happen before the row is built, not at read time.
 */

/** Keys whose values are never recorded, matched case-insensitively. */
const SECRET_KEY = /(secret|token|password|passwd|credential|authorization|api[_-]?key|private[_-]?key|content_base64)/iu;

/** Longest string kept verbatim; anything longer is previewed with its size. */
const MAX_STRING = 600;
/** Hard ceiling on a serialised payload, after per-string trimming. */
const MAX_PAYLOAD_BYTES = 8_000;

export function redactPayload(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[${value.length} chars total]`
      : value;
  }
  if (depth > 6) return '[nested]';
  if (Array.isArray(value)) {
    const kept = value.slice(0, 20).map((entry) => redactPayload(entry, depth + 1));
    return value.length > 20 ? [...kept, `…[${value.length} items total]`] : kept;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // Redact by key name rather than by inspecting the value: a token looks
      // like any other string, and guessing wrong writes a live credential.
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactPayload(entry, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function serialiseBounded(value: unknown): { json: string; bytes: number } {
  let json: string;
  try {
    json = JSON.stringify(redactPayload(value)) ?? 'null';
  } catch {
    json = '"[unserialisable]"';
  }
  const bytes = json.length;
  return { json: bytes > MAX_PAYLOAD_BYTES ? `${json.slice(0, MAX_PAYLOAD_BYTES)}…[truncated]` : json, bytes };
}

export interface ToolCallRecord {
  tenantId: string;
  projectId?: string;
  workspaceId?: string | null;
  clientName?: string;
  tool: string;
  status: 'success' | 'error';
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  request: unknown;
  response: unknown;
}

export async function recordToolCall(env: Env, record: ToolCallRecord): Promise<void> {
  const request = serialiseBounded(record.request);
  const response = serialiseBounded(record.response);
  await env.METADATA.prepare(
    `INSERT INTO mcp_tool_calls
       (id, tenant_id, project_id, workspace_id, client_name, tool, status, duration_ms,
        error_code, error_message, request_json, response_json, request_bytes, response_bytes, occurred_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
  ).bind(
    ids.operation(),
    record.tenantId,
    record.projectId ?? null,
    record.workspaceId ?? null,
    record.clientName ?? null,
    record.tool,
    record.status,
    Math.round(record.durationMs),
    record.errorCode ?? null,
    record.errorMessage?.slice(0, 1_000) ?? null,
    request.json,
    response.json,
    request.bytes,
    response.bytes,
    new Date().toISOString()
  ).run();
}

export async function recentToolCalls(
  env: Env,
  input: { tenantId: string; workspaceId?: string; onlyErrors?: boolean; limit?: number }
): Promise<unknown[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const where = ['tenant_id = ?1'];
  const binds: unknown[] = [input.tenantId];
  if (input.workspaceId) {
    binds.push(input.workspaceId);
    where.push(`workspace_id = ?${binds.length}`);
  }
  if (input.onlyErrors) where.push(`status = 'error'`);
  binds.push(limit);
  const rows = await env.METADATA.prepare(
    `SELECT tool, status, duration_ms, error_code, error_message, request_json, response_json,
            request_bytes, response_bytes, client_name, workspace_id, occurred_at
       FROM mcp_tool_calls WHERE ${where.join(' AND ')}
      ORDER BY occurred_at DESC LIMIT ?${binds.length}`
  ).bind(...binds).all();
  return rows.results ?? [];
}
