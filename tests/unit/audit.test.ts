import { describe, expect, it } from 'vitest';
import { D1AuditStore, redact } from '@forge/audit';
import type { ForgeEvent } from '@forge/events';

describe('audit package', () => {
  it('redacts sensitive tokens in text', () => {
    const raw = 'authorization: bearer my-token-123 github_pat_1234567890abcdef ghp_abc123';
    const cleaned = redact(raw);
    expect(cleaned).not.toContain('my-token-123');
    expect(cleaned).not.toContain('github_pat_');
    expect(cleaned).not.toContain('ghp_abc123');
    expect(cleaned).toContain('[REDACTED]');
  });

  it('appends audit event to D1 database with redacted payload', async () => {
    let executedSql = '';
    let boundParams: unknown[] = [];

    const mockDb = {
      prepare(sql: string) {
        executedSql = sql;
        return {
          bind(...args: unknown[]) {
            boundParams = args;
            return {
              async run() {
                return { success: true };
              }
            };
          }
        };
      }
    };

    const store = new D1AuditStore(mockDb);

    const event: ForgeEvent<{ taskId?: string; authorization: string }> = {
      schemaVersion: 1,
      id: 'evt_1234567890',
      traceId: 'trc_1234567890',
      tenantId: 'ten_abc123' as any,
      workspaceId: 'wsp_abc123' as any,
      actor: { type: 'user', id: 'usr_123' },
      type: 'workspace.created',
      occurredAt: '2026-07-27T08:00:00.000Z',
      payload: {
        taskId: 'task_1234567890',
        authorization: 'authorization: bearer secret-token-xyz'
      }
    };

    await store.append(event);

    expect(executedSql).toContain('INSERT INTO audit_events');
    expect(boundParams[0]).toBe('evt_1234567890');
    expect(boundParams[1]).toBe('ten_abc123');
    expect(boundParams[2]).toBe('wsp_abc123');
    expect(boundParams[3]).toBe('task_1234567890');
    expect(boundParams[4]).toBe('workspace.created');
    expect(boundParams[5]).toBe('2026-07-27T08:00:00.000Z');
    expect(typeof boundParams[6]).toBe('string');
    expect(boundParams[6] as string).not.toContain('secret-token-xyz');
    expect(boundParams[6] as string).toContain('[REDACTED]');
  });
});
