import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Best-effort inline approval via MCP's URL-mode elicitation
 * (`elicitation/create` with mode 'url'), instead of forcing every approval
 * out to a link the agent has to paste into chat text. This is additive: the
 * external approval_url the caller already gets is unaffected, and every
 * failure mode here (unsupported client, timeout, decline) falls straight
 * back to that existing flow — nothing about this can make a push/PR/command
 * happen without a real human decision, it only changes where that decision
 * is surfaced.
 *
 * Bounded with a timeout so a Durable Object invocation can never hang
 * indefinitely on an unresponsive or non-existent human. Unverified against
 * real ChatGPT/Claude clients — as of writing neither is known to advertise
 * the `elicitation.url` capability, so in practice this is inert today and
 * activates automatically the moment a client does.
 */
export async function elicitInlineApproval(
  server: McpServer,
  elicitationId: string,
  message: string,
  url: string,
  timeoutMs = 5 * 60_000
): Promise<'accept' | 'decline' | 'cancel' | 'unsupported'> {
  const rpc = (server as unknown as {
    server?: {
      getClientCapabilities?: () => { elicitation?: { url?: boolean } } | undefined;
      elicitInput?: (
        params: { mode: 'url'; message: string; elicitationId: string; url: string },
        options?: { timeout?: number }
      ) => Promise<{ action: 'accept' | 'decline' | 'cancel' }>;
    };
  }).server;
  if (!rpc?.getClientCapabilities?.()?.elicitation?.url || !rpc.elicitInput) return 'unsupported';
  try {
    const result = await rpc.elicitInput({ mode: 'url', message, elicitationId, url }, { timeout: timeoutMs });
    return result.action;
  } catch {
    // Client claimed the capability but the request failed, timed out, or the
    // connection dropped mid-decision — the external approval_url the agent
    // already has is the safety net; say nothing louder than that.
    return 'unsupported';
  }
}
