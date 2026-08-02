import type { ForgeEvent } from '@forge/events';
const secretPatterns = [/[A-Za-z0-9_]{36,255}/g, /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, /authorization:\s*bearer\s+\S+/ig, /github_pat_[A-Za-z0-9_]+/g, /gh[opsu]_[A-Za-z0-9]+/g];
export function redact(value: string): string { return secretPatterns.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value); }
export interface AuditStore { append(event: ForgeEvent): Promise<void>; }

/**
 * Minimal D1-backed AuditStore. This is the durable "what actually happened"
 * trail — an append-only complement to task summaries, which are the agent's
 * own self-reported account and can drift from reality (an agent claiming a
 * task "complete" whose branch was never actually pushed, for example).
 * Deliberately narrow: only mutating, consequential actions get logged here
 * (see call sites). High-volume per-call telemetry is D1 `mcp_tool_calls`.
 */
export class D1AuditStore implements AuditStore {
  constructor(private readonly db: { prepare: (sql: string) => { bind: (...args: unknown[]) => { run: () => Promise<unknown> } } }) {}

  async append(event: ForgeEvent): Promise<void> {
    const payload = redact(JSON.stringify(event.payload ?? {}));
    await this.db
      .prepare(
        'INSERT INTO audit_events (id, tenant_id, workspace_id, task_id, type, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        event.id,
        event.tenantId,
        event.workspaceId ?? null,
        (event.payload as { taskId?: string } | undefined)?.taskId ?? null,
        event.type,
        event.occurredAt,
        payload
      )
      .run();
  }
}
