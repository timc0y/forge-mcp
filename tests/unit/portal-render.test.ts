import { describe, expect, it } from 'vitest';
import {
  appDashboard,
  approvalPage,
  approvalStillUsable,
  listPendingSyncApprovals
} from '../../apps/forge-edge-gateway/src/github';
import { rebindDeferredApproval } from '../../apps/forge-edge-gateway/src/deferred-actions';

// Both pages are large HTML templates with many interpolations, and they are the
// entire human half of the async approval flow — if either throws or silently
// drops its call to action, work sits in the queue with no way to approve it.
// These render them against fixed data and assert what a reviewer must be able
// to see and act on.

const DIFF = `diff --git a/src/site.ts b/src/site.ts
--- a/src/site.ts
+++ b/src/site.ts
@@ -1,1 +1,1 @@
-old
+new
`;

const user = {
  id: 'usr_1', github_user_id: '1', github_login: 'octocat',
  avatar_url: null, tenant_id: 'ten_1', project_id: 'prj_1', is_owner: 1
};

const deferred = {
  id: 'dfr_1', tenant_id: 'ten_1', project_id: 'prj_1', workspace_id: 'ws_1',
  approval_id: 'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa', task_id: null, action: 'work.submit',
  repo_owner: 'octocat', repo_name: 'site', branch: 'forge/fix', base: 'main',
  staged_ref: 'forge/staged/ws_1/fix', commit_sha: 'a'.repeat(40),
  title: 'Fix homepage typo', body: 'Body', summary: '1 file changed', files_changed: 1,
  pull_request_number: null, merge_method: null,
  idempotency_key: null, retryable: 1,
  state: 'awaiting_approval', result: null, error: null,
  created_at: new Date(Date.now() - 45 * 60_000).toISOString(), updated_at: new Date().toISOString(),
  preview_workspace_id: null, preview_state: 'none', preview_id: null,
  preview_expires_at: null, preview_error: null, github_repository_id: '99'
};

const syncApproval = {
  id: 'apr_bbbbbbbbbbbbbbbbbbbbbbbbbb',
  requested_action: 'shell.exec',
  reason: 'npm install',
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  workspace_id: 'ws_2'
};

function env(approvalState = 'pending', options: { expiresAt?: string; sync?: typeof syncApproval[] } = {}) {
  const approval = {
    requested_action: 'work.submit', reason: 'Merge forge/fix into main',
    request_payload: JSON.stringify({ branch: 'forge/fix', base: 'main', title: 'Fix homepage typo', diff: DIFF }),
    state: approvalState,
    expires_at: options.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    workspace_id: 'ws_1'
  };
  const syncRows = options.sync ?? [];
  return {
    FORGE_PUBLIC_ORIGIN: 'https://forge.test',
    FORGE_ENVIRONMENT: 'production',
    FORGE_SLOT_TTL_MINUTES: '240',
    METADATA: {
      prepare(sql: string) {
        const statement: Record<string, unknown> = {
          bind: () => statement,
          first: async () => {
            if (sql.includes('FROM web_sessions')) return user;
            if (sql.includes('FROM approvals')) return approval;
            if (sql.includes('FROM deferred_actions')) return deferred;
            return null;
          },
          all: async () => {
            if (sql.includes("requested_action != 'work.submit'")) {
              return { results: syncRows };
            }
            if (sql.includes('deferred_actions')) return { results: [deferred] };
            if (sql.includes('repositories')) {
              return { results: [{ owner: 'octocat', name: 'site', visibility: 'private', default_branch: 'main' }] };
            }
            return { results: [] };
          },
          run: async () => ({ meta: { changes: 1 } })
        };
        return statement;
      }
    }
  } as never;
}

const request = (url: string, init?: RequestInit) => new Request(url, {
  ...init,
  headers: { cookie: 'forge_session=abc', origin: 'https://forge.test', ...(init?.headers ?? {}) }
});
const APPROVAL_URL = 'https://forge.test/approvals/apr_aaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('reviewer-facing pages', () => {
  it('presents direct-chat deploy approval as self-executing with a durable status link', async () => {
    const directEnv = env() as unknown as { METADATA: { prepare(sql: string): unknown } };
    const originalPrepare = directEnv.METADATA.prepare.bind(directEnv.METADATA);
    directEnv.METADATA.prepare = (sql: string) => {
      if (sql.includes('FROM approvals')) {
        const statement: Record<string, unknown> = {
          bind: () => statement,
          first: async () => ({
            requested_action: 'cloudflare.deploy', reason: 'Deploy preview',
            request_payload: JSON.stringify({
              chat_operation_id: 'op_aaaaaaaaaaaaaaaaaaaaaaaaaa',
              status_url: 'https://forge.test/status/op_aaaaaaaaaaaaaaaaaaaaaaaaaa?t=signed',
              repository_ref: 'octocat/site#forge/release'
            }),
            state: 'pending', expires_at: new Date(Date.now() + 3_600_000).toISOString(), workspace_id: 'ws_1'
          })
        };
        return statement;
      }
      if (sql.includes('FROM deferred_actions')) {
        const statement: Record<string, unknown> = { bind: () => statement, first: async () => null };
        return statement;
      }
      return originalPrepare(sql);
    };

    const response = await approvalPage(request(APPROVAL_URL), directEnv as never, 'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const html = await response.text();
    expect(html).toContain('Open deployment status');
    expect(html).not.toContain('agent that asked can carry it out');
  });

  it('renders an approval with everything needed to decide', async () => {
    const response = await approvalPage(request(APPROVAL_URL), env(), 'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(response.status).toBe(200);
    const html = await response.text();
    // The decision itself.
    expect(html).toContain('value="approved"');
    expect(html).toContain('value="denied"');
    // What is being decided, and the reassurance that nothing is blocked on it.
    expect(html).toContain('Waiting on you');
    expect(html).toContain('forge/staged/ws_1/fix');
    // The diff, rendered rather than dumped as a payload blob.
    expect(html).toContain('src/site.ts');
    // The on-demand preview, with its result link inert until one exists.
    expect(html).toContain('Launch preview');
    expect(html).toMatch(/<a class="pvlink"[^>]*hidden/);
    // …and a rule that actually honours `hidden`, which display:inline-flex
    // would otherwise override, showing a dead "Open preview" link immediately.
    expect(html).toContain('.pvlink[hidden]');
    // The sticky action bar needs an opaque backdrop, or page content scrolls
    // underneath it and sits unreadable behind the buttons on a phone.
    expect(html).toMatch(/form\.decide\{[^}]*position:sticky[^}]*background:var\(--bg\)/);
  });

  it('renders pull-request merge approval as self-executing and without preview controls', async () => {
    const mergeEnv = env();
    const originalPrepare = mergeEnv.METADATA.prepare.bind(mergeEnv.METADATA);
    mergeEnv.METADATA.prepare = (sql: string) => {
      if (sql.includes('FROM approvals')) {
        const statement: Record<string, unknown> = {
          bind: () => statement,
          first: async () => ({
            requested_action: 'pull_request.merge',
            reason: 'Merge pull request #7',
            request_payload: JSON.stringify({ action: 'merge', owner: 'octocat', repo: 'site', number: 7, headSha: 'a'.repeat(40), mergeMethod: 'squash' }),
            state: 'pending',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            workspace_id: 'repository:octocat/site'
          })
        };
        return statement;
      }
      if (sql.includes('FROM deferred_actions')) {
        const statement: Record<string, unknown> = {
          bind: () => statement,
          first: async () => ({
            ...deferred,
            action: 'pull_request.merge',
            workspace_id: 'repository:octocat/site',
            branch: 'feature/login',
            base: 'main',
            title: 'Fix login',
            pull_request_number: 7,
            merge_method: 'squash'
          })
        };
        return statement;
      }
      return originalPrepare(sql);
    };

    const response = await approvalPage(request(APPROVAL_URL), mergeEnv, 'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const html = await response.text();
    expect(html).toContain('Merge pull request #7');
    expect(html).toContain('Approve &amp; merge pull request');
    expect(html).not.toContain('Launch preview');
    expect(html).toContain('without another chat call');
  });

  it('shows the outcome instead of the buttons once decided', async () => {
    const response = await approvalPage(request(APPROVAL_URL), env('approved'), 'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const html = await response.text();
    expect(html).not.toContain('value="approved"');
    expect(html).toContain('Action approved');
  });

  it('keeps deferred submissions decidable after the approvals TTL lapses', async () => {
    // The bug: portal showed the queue item, but Approve died with "expired"
    // because work.submit reused the short sync TTL.
    const expired = new Date(Date.now() - 60_000).toISOString();
    const response = await approvalPage(
      request(APPROVAL_URL),
      env('pending', { expiresAt: expired }),
      'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    const html = await response.text();
    expect(html).toContain('value="approved"');
    expect(html).not.toContain('This approval has expired');
  });

  it('accepts a deferred Approve even when expires_at is in the past', async () => {
    const expired = new Date(Date.now() - 60_000).toISOString();
    const response = await approvalPage(
      request(APPROVAL_URL, {
        method: 'POST',
        body: 'decision=approved',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }
      }),
      env('pending', { expiresAt: expired }),
      'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    expect(response.status).toBe(303);
  });

  it('puts the review queue on the dashboard with a way into each item', async () => {
    const response = await appDashboard(request('https://forge.test/app'), env());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Waiting for your review');
    expect(html).toContain('Fix homepage typo');
    expect(html).toContain('/approvals/apr_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(html).toContain('Sync approvals');
    // Approving happens on a phone; keep the tap target at the page's own 44px.
    // Tap targets come from the shared sheet now, so every surface gets them.
    expect(html).toMatch(/\.btn,button\{[^}]*min-height:44px/);
  });

  it('surfaces pending sync approvals on the dashboard, not only deferred submissions', async () => {
    const response = await appDashboard(
      request('https://forge.test/app'),
      env('pending', { sync: [syncApproval] })
    );
    const html = await response.text();
    expect(html).toContain('Shell command');
    expect(html).toContain('npm install');
    expect(html).toContain('/approvals/apr_bbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(html).toContain('badge">2<');
  });

  it('lets a failed deferred submission be retried after the approval was already spent', async () => {
    const failedDeferred = { ...deferred, state: 'failed', error: 'GitHub rejected the push' };
    const failedEnv = env('approved');
    failedEnv.METADATA.prepare = (sql: string) => {
      const statement: Record<string, unknown> = {
        bind: () => statement,
        first: async () => {
          if (sql.includes('FROM web_sessions')) return user;
          if (sql.includes('FROM approvals')) {
            return {
              requested_action: 'work.submit',
              reason: 'Merge forge/fix into main',
              request_payload: JSON.stringify({ branch: 'forge/fix', base: 'main', title: 'Fix homepage typo', diff: DIFF }),
              state: 'approved',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              workspace_id: 'ws_1'
            };
          }
          if (sql.includes('FROM deferred_actions')) return failedDeferred;
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } })
      };
      return statement as never;
    };
    const response = await approvalPage(request(APPROVAL_URL), failedEnv, 'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const html = await response.text();
    expect(html).toContain('Retry opening pull request');
    expect(html).toContain('value="approved"');
    expect(html).toContain('approving again retries');
  });

  it('does not offer a retry button for a non-retryable merge failure', async () => {
    const failedMerge = {
      ...deferred,
      action: 'pull_request.merge',
      workspace_id: 'repository:octocat/site',
      branch: 'feature/login',
      pull_request_number: 7,
      merge_method: 'squash',
      state: 'failed',
      retryable: 0,
      error: 'The pull-request head moved; request a fresh forge_merge.'
    };
    const failedEnv = env('approved');
    failedEnv.METADATA.prepare = (sql: string) => {
      const statement: Record<string, unknown> = {
        bind: () => statement,
        first: async () => {
          if (sql.includes('FROM web_sessions')) return user;
          if (sql.includes('FROM approvals')) {
            return {
              requested_action: 'pull_request.merge',
              reason: 'Merge pull request #7',
              request_payload: JSON.stringify({ action: 'merge', number: 7, mergeMethod: 'squash' }),
              state: 'approved',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              workspace_id: 'repository:octocat/site'
            };
          }
          if (sql.includes('FROM deferred_actions')) return failedMerge;
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } })
      };
      return statement as never;
    };
    const response = await approvalPage(request(APPROVAL_URL), failedEnv, 'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const html = await response.text();
    expect(html).toContain('request a fresh forge_merge');
    expect(html).not.toContain('Retry merge');
    expect(html).not.toContain('value="approved"');
  });

  it('shows a visible error when the review queue fails to load', async () => {
    const broken = env();
    broken.METADATA.prepare = (sql: string) => {
      const statement: Record<string, unknown> = {
        bind: () => statement,
        first: async () => {
          if (sql.includes('FROM web_sessions')) return user;
          return null;
        },
        all: async () => {
          if (sql.includes('deferred_actions') || sql.includes("requested_action != 'work.submit'")) {
            throw new Error('d1 unavailable');
          }
          if (sql.includes('repositories')) {
            return { results: [{ owner: 'octocat', name: 'site', visibility: 'private', default_branch: 'main' }] };
          }
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 1 } })
      };
      return statement as never;
    };
    const response = await appDashboard(request('https://forge.test/app'), broken);
    const html = await response.text();
    expect(html).toContain('Could not load the review queue');
  });

  it('explains the private-App collaboration flow without linking collaborators to GitHub 404s', async () => {
    const collaboratorEnv = env();
    collaboratorEnv.METADATA.prepare = (sql: string) => {
      const statement: Record<string, unknown> = {
        bind: () => statement,
        first: async () => {
          if (sql.includes('FROM web_sessions')) return { ...user, id: 'usr_bro', github_login: 'bro', is_owner: 0 };
          if (sql.includes('FROM approvals')) return { requested_action: 'work.submit', state: 'pending', expires_at: new Date(Date.now() + 3_600_000).toISOString() };
          return null;
        },
        all: async () => {
          if (sql.includes('deferred_actions')) return { results: [] };
          if (sql.includes('repositories')) return { results: [] };
          return { results: [] };
        },
        run: async () => ({ meta: { changes: 1 } })
      };
      return statement as never;
    };
    const response = await appDashboard(request('https://forge.test/app'), collaboratorEnv);
    const html = await response.text();
    expect(html).toContain('Private owner-managed connection');
    expect(html).toContain('do not install the GitHub App');
    expect(html).not.toContain('Install or add repositories');
  });
});

describe('approval helpers', () => {
  it('treats expired or spent approvals as unusable for replay', () => {
    expect(approvalStillUsable(null)).toBe(false);
    expect(approvalStillUsable({ state: 'pending', expiresAt: new Date(Date.now() - 1_000).toISOString() })).toBe(false);
    expect(approvalStillUsable({ state: 'consumed', expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
    expect(approvalStillUsable({ state: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
  });

  it('lists only non-deferred pending sync approvals', async () => {
    const rows = [syncApproval];
    const fakeEnv = {
      METADATA: {
        prepare(sql: string) {
          const statement = {
            bind: () => statement,
            all: async () => {
              expect(sql).toContain("requested_action != 'work.submit'");
              expect(sql).toContain("requested_action != 'pull_request.merge'");
              return { results: rows };
            }
          };
          return statement;
        }
      }
    } as never;
    const listed = await listPendingSyncApprovals(fakeEnv, 'ten_1');
    expect(listed).toEqual([{
      id: syncApproval.id,
      requestedAction: 'shell.exec',
      reason: 'npm install',
      expiresAt: syncApproval.expires_at,
      workspaceId: 'ws_2'
    }]);
  });

  it('rebinds a deferred action onto a fresh approval id', async () => {
    const rows: Array<Record<string, unknown>> = [{
      id: 'dfr_1',
      state: 'awaiting_approval',
      approval_id: 'apr_old'
    }];
    const fakeEnv = {
      METADATA: {
        prepare(sql: string) {
          let values: unknown[] = [];
          const statement = {
            bind(...args: unknown[]) {
              values = args;
              return statement;
            },
            async run() {
              expect(sql).toContain('SET approval_id=?1');
              const row = rows.find((candidate) => candidate.id === values[2]);
              if (row) row.approval_id = values[0];
              return { meta: { changes: 1 } };
            }
          };
          return statement;
        }
      }
    } as never;
    await rebindDeferredApproval(fakeEnv, 'dfr_1', 'apr_new');
    expect(rows[0]?.approval_id).toBe('apr_new');
  });
});
