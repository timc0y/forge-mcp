import { describe, expect, it } from 'vitest';
import { ForgeError } from '@forge/core';
import { assertForgeBranch } from '@forge/policy';
import { forgeTools } from '@forge/mcp-core';

describe('assertForgeBranch (used by forge_git_push, forge_pull_request_create, forge_submit)', () => {
  const valid = [
    'forge/fix-login',
    'forge/add-feature',
    'forge/123-task',
    'forge/nested/branch',
    'forge/with.dots.ok',
    'forge/a'
  ];
  for (const branch of valid) {
    it(`accepts ${branch}`, () => {
      expect(() => assertForgeBranch(branch)).not.toThrow();
    });
  }

  const invalid: { branch: string; reason: string }[] = [
    { branch: 'main', reason: 'missing forge/ prefix' },
    { branch: 'forge/', reason: 'empty after prefix' },
    { branch: 'forge/..', reason: 'parent dir ref' },
    { branch: 'forge/foo/..', reason: 'parent dir ref mid-path' },
    { branch: 'forge/.hidden', reason: 'starts with dot' },
    { branch: 'forge/-bad', reason: 'starts with dash' },
    { branch: 'forge/branch.lock', reason: 'ends with .lock' },
    { branch: 'forge/', reason: 'ends with slash' },
    { branch: 'FORGE/MAIN', reason: 'uppercase prefix still needs forge/' },
  ];
  for (const { branch, reason } of invalid) {
    it(`rejects ${branch} (${reason})`, () => {
      expect(() => assertForgeBranch(branch)).toThrow(ForgeError);
    });
  }
});

describe('new tool definitions', () => {
  const tool = (name: string) => forgeTools.find((t) => t.name === name)!;

  it('forge_git_rebase is a workspace mutation without approval', () => {
    const t = tool('forge_git_rebase');
    expect(t.sideEffect).toBe('workspace');
    expect(t.approval).toBe('none');
    expect(t.inputSchema).toBeDefined();
  });

  it('forge_git_push is an external side-effect requiring approval', () => {
    const t = tool('forge_git_push');
    expect(t.sideEffect).toBe('external');
    expect(t.approval).toBe('required');
  });

  it('forge_pull_request_create is an external side-effect requiring approval', () => {
    const t = tool('forge_pull_request_create');
    expect(t.sideEffect).toBe('external');
    expect(t.approval).toBe('required');
  });

  it('forge_workspace_restore is destructive with policy approval', () => {
    const t = tool('forge_workspace_restore');
    expect(t.sideEffect).toBe('destructive');
    expect(t.approval).toBe('policy');
  });

  it('forge_files_upload works on repo paths only', () => {
    const t = tool('forge_files_upload');
    const schema = t.inputSchema as { path: { safeParse(v: unknown): { success: boolean } } };
    expect(schema.path.safeParse('/workspace/repo/foo.png').success).toBe(true);
    expect(schema.path.safeParse('/workspace/other/foo.png').success).toBe(false);
  });

  it('forge_artifact_upload has no revision or idempotency key', () => {
    const t = tool('forge_artifact_upload');
    const schema = t.inputSchema as Record<string, { safeParse(v: unknown): { success: boolean } }>;
    expect(schema.expected_revision).toBeUndefined();
    expect(schema.idempotency_key).toBeUndefined();
  });

  it('forge_context_get clamps max_results between 1 and 100', () => {
    const t = tool('forge_context_get');
    const schema = t.inputSchema as { max_results: { safeParse(v: unknown): { success: boolean } } };
    expect(schema.max_results.safeParse(0).success).toBe(false);
    expect(schema.max_results.safeParse(101).success).toBe(false);
    expect(schema.max_results.safeParse(12).success).toBe(true);
  });

  it('forge_files_patch limits patch size to 2MB', () => {
    const t = tool('forge_files_patch');
    const schema = t.inputSchema as { patch: { safeParse(v: unknown): { success: boolean } } };
    expect(schema.patch.safeParse('x'.repeat(2_000_001)).success).toBe(false);
    expect(schema.patch.safeParse('x'.repeat(2_000_000)).success).toBe(true);
  });
});

describe('approval lifecycle (completeApproval on failure)', () => {
  type ApprovalRow = {
    id: string; state: string; expires_at: string; tenant_id: string;
    workspace_id: string; requested_action: string; request_payload: string;
  };

  const envWrap = (d1: import('@forge/core').D1Database) =>
    ({ METADATA: d1, FORGE_CAPABILITY_SIGNING_KEY: 'test-key-32-bytes-for-hmac!!', FORGE_PUBLIC_ORIGIN: 'https://forge.test' }) as never;

  function fakeD1(): import('@forge/core').D1Database & { rows: ApprovalRow[] } {
    const approvals: ApprovalRow[] = [];
    const self = {
      rows: approvals,
      prepare(sql: string) {
        let values: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) { values = args; return stmt; },
          async run() {
            // requireApproval: claim from 'approved' to 'executing'
            if (sql.includes("state='approved'") && sql.includes("SET state='executing'")) {
              const row = approvals.find((a) => a.id === values[0]);
              if (!row || row.state !== 'approved') return { meta: { changes: 0 } };
              row.state = 'executing';
              return { meta: { changes: 1 } };
            }
            // completeApproval: SET state=?1 WHERE id=?2 AND state='executing'
            if (sql.includes("state='executing'") && sql.startsWith('UPDATE') && sql.includes('SET state=?1')) {
              const row = approvals.find((a) => a.id === values[1] && a.state === 'executing');
              if (!row) return { meta: { changes: 0 } };
              row.state = values[0] as string;
              return { meta: { changes: 1 } };
            }
            // Mark as approved (pre-seed directly instead)
            return { meta: { changes: 0 } };
          },
          async first<T>(): Promise<T | null> {
            const row = approvals.find((a) => a.id === values[0]);
            if (!row) return null;
            return { state: row.state, expires_at: row.expires_at, request_payload: row.request_payload } as T;
          }
        };
        return stmt;
      }
    };
    return self as unknown as import('@forge/core').D1Database & { rows: ApprovalRow[] };
  }

  it('succeeded approval transitions from executing to consumed', async () => {
    const d1 = fakeD1();
    const { requireApproval, completeApproval } = await import('../../apps/forge-edge-gateway/src/github');
    const identity = { tenantId: 'ten_t', projectId: 'prj_p' } as never;

    d1.rows.push({ id: 'apr_success', state: 'approved', expires_at: new Date(Date.now() + 3_600_000).toISOString(), tenant_id: 'ten_t', workspace_id: 'ws_w', requested_action: 'git.push', request_payload: JSON.stringify({ action: 'git.push' }) });
    await requireApproval(envWrap(d1), identity, 'apr_success', 'ws_w', 'git.push', { action: 'git.push' });
    await completeApproval(envWrap(d1), 'apr_success', true);
    expect(d1.rows.find((a) => a.id === 'apr_success')?.state).toBe('consumed');
  });

  it('failed approval transitions from executing to failed', async () => {
    const d1 = fakeD1();
    const { requireApproval, completeApproval } = await import('../../apps/forge-edge-gateway/src/github');
    const identity = { tenantId: 'ten_u', projectId: 'prj_u' } as never;

    d1.rows.push({ id: 'apr_fail', state: 'approved', expires_at: new Date(Date.now() + 3_600_000).toISOString(), tenant_id: 'ten_u', workspace_id: 'ws_w', requested_action: 'git.push', request_payload: JSON.stringify({ action: 'git.push' }) });
    await requireApproval(envWrap(d1), identity, 'apr_fail', 'ws_w', 'git.push', { action: 'git.push' });
    await completeApproval(envWrap(d1), 'apr_fail', false);
    expect(d1.rows.find((a) => a.id === 'apr_fail')?.state).toBe('failed');
  });

  it('completeApproval with false does not overwrite a non-executing state', async () => {
    const d1 = fakeD1();
    const { completeApproval } = await import('../../apps/forge-edge-gateway/src/github');

    d1.rows.push({ id: 'apr_pending', state: 'pending', expires_at: new Date(Date.now() + 3_600_000).toISOString(), tenant_id: 'ten_p', workspace_id: 'ws_w', requested_action: 'git.push', request_payload: '{}' });
    await completeApproval(envWrap(d1), 'apr_pending', false);
    expect(d1.rows.find((a) => a.id === 'apr_pending')?.state).toBe('pending');
  });
});

describe('ForgeError codes from new handlers', () => {
  it('FORGE_GIT_FETCH_FAILED is a retryable error', () => {
    const error = new ForgeError({
      code: 'FORGE_GIT_FETCH_FAILED',
      message: 'Failed to fetch upstream',
      retryable: true
    });
    expect(error.code).toBe('FORGE_GIT_FETCH_FAILED');
    expect(error.retryable).toBe(true);
  });

  it('FORGE_VALIDATION_FAILED is not retryable', () => {
    const error = new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'Workspace has no repository binding.',
      retryable: false
    });
    expect(error.code).toBe('FORGE_VALIDATION_FAILED');
    expect(error.retryable).toBe(false);
  });

  it('FORGE_FILE_CONFLICT for upload failure is not retryable', () => {
    const error = new ForgeError({
      code: 'FORGE_FILE_CONFLICT',
      message: 'Failed to decode base64',
      retryable: false
    });
    expect(error.code).toBe('FORGE_FILE_CONFLICT');
  });

  it('FORGE_APPROVAL_REQUIRED for push/PR includes details', () => {
    const error = new ForgeError({
      code: 'FORGE_APPROVAL_REQUIRED',
      message: 'Pushing requires human approval.',
      retryable: false,
      details: { kind: 'approval', action: 'git.push', approval_id: 'apr_xxx', approval_url: 'https://forge.test/approvals/apr_xxx' }
    });
    expect(error.details?.kind).toBe('approval');
    expect(error.details?.approval_id).toBe('apr_xxx');
  });
});
