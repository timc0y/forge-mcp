// Fire-and-forget PostHog telemetry for MCP tool usage: latency, errors, and
// repeated identical calls (a proxy for an agent retrying/flailing). Emits via
// PostHog's HTTP capture API directly — no SDK — since a Worker/Durable Object
// request has no long-lived process to run posthog-node's internal batch queue.
// Disabled (no-op) whenever POSTHOG_API_KEY is unset, so it's safe to leave off
// in local/dev environments.

import type { Env } from './env';

const DEFAULT_HOST = 'https://us.i.posthog.com';

// Repeated identical (tool, args) calls within this window, from the same
// session, are tagged is_repeat_call so PostHog can surface flailing/retry
// loops. Bounded LRU-ish map per Durable Object instance (i.e. per MCP
// session) — cheap, no cross-session state needed.
const REPEAT_WINDOW_MS = 5 * 60 * 1000;
const REPEAT_MAP_MAX = 200;

export interface ToolCallEvent {
  tool: string;
  distinctId: string;
  sessionId: string;
  clientName?: string;
  durationMs: number;
  status: 'success' | 'error';
  errorCode?: string;
  errorMessage?: string;
  resultBytes?: number;
  argsHash: string;
}

export class ToolCallTracker {
  private recentCalls = new Map<string, number>();

  constructor(
    private readonly env: Env,
    private readonly ctx: { waitUntil?: (p: Promise<unknown>) => void } | undefined
  ) {}

  private isRepeat(key: string, now: number): boolean {
    const last = this.recentCalls.get(key);
    // Evict opportunistically so the map never grows unbounded across a
    // long-lived session.
    if (this.recentCalls.size > REPEAT_MAP_MAX) {
      for (const [k, t] of this.recentCalls) {
        if (now - t > REPEAT_WINDOW_MS) this.recentCalls.delete(k);
      }
    }
    this.recentCalls.set(key, now);
    return last !== undefined && now - last < REPEAT_WINDOW_MS;
  }

  capture(event: ToolCallEvent, now: number): void {
    const apiKey = this.env.POSTHOG_API_KEY;
    if (!apiKey) return;

    const repeatKey = `${event.sessionId}:${event.tool}:${event.argsHash}`;
    const isRepeatCall = this.isRepeat(repeatKey, now);

    const host = this.env.POSTHOG_HOST || DEFAULT_HOST;
    const body = JSON.stringify({
      api_key: apiKey,
      event: 'mcp_tool_call',
      distinct_id: event.distinctId,
      properties: {
        tool: event.tool,
        $session_id: event.sessionId,
        client_name: event.clientName ?? 'unknown',
        duration_ms: event.durationMs,
        status: event.status,
        error_code: event.errorCode,
        error_message: event.errorMessage,
        result_bytes: event.resultBytes,
        is_repeat_call: isRepeatCall,
        environment: this.env.FORGE_ENVIRONMENT
      }
    });

    const send = fetch(`${host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    }).catch((error) => {
      console.error('posthog_capture_failed', { name: error instanceof Error ? error.name : 'unknown' });
    });

    if (this.ctx?.waitUntil) {
      this.ctx.waitUntil(send);
    }
  }
}

/** Cheap, non-cryptographic hash for repeat-call detection — not a secret. */
export async function hashArgs(input: unknown): Promise<string> {
  const json = JSON.stringify(input) ?? '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
