import { REMOVED_TOOLS } from '@forge/mcp-core';

/**
 * Answer a call to a tool that no longer exists.
 *
 * A client caches `tools/list` when it connects, so every session open when
 * the catalog shrank still believes the old tools exist. Letting those calls
 * reach the MCP server produces a bare `-32602 Tool not found`: no error code,
 * no replacement, no hint that reconnecting fixes it — and an agent that meets
 * it works down the list, trying five dead write tools in a row. That is the
 * retry storm this redesign exists to remove, reintroduced by the removal.
 *
 * Answering here rather than registering tombstone tools keeps `tools/list` at
 * the real size. Re-advertising seventeen dead names would spend every future
 * session's tool budget to help the sessions open right now.
 */
export function removedToolCall(body: string): { id: unknown; name: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  // A batch is answered only when it is exactly one removed call; mixed batches
  // fall through so the real tools in them still run.
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length !== 1) return null;
  const message = messages[0] as { method?: unknown; id?: unknown; params?: { name?: unknown } } | null;
  if (!message || message.method !== 'tools/call') return null;
  const name = message.params?.name;
  if (typeof name !== 'string' || !(name in REMOVED_TOOLS)) return null;
  return { id: message.id ?? null, name };
}

export function removedToolResponse(call: { id: unknown; name: string }): unknown {
  const replacement = REMOVED_TOOLS[call.name] as string;
  return {
    jsonrpc: '2.0',
    id: call.id,
    result: {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'FORGE_VALIDATION_FAILED',
              message: `${call.name} no longer exists. ${replacement} Your client is showing a stale tool list — reconnect to Forge to refresh it, and do not try the other file or git tools; they were removed together.`,
              retryable: false,
              details: { removedTool: call.name, useInstead: replacement, action: 'reconnect_to_refresh_tools' }
            }
          })
        }
      ]
    }
  };
}
