import { describe, expect, it } from 'vitest';
import { appDashboard, approvalPage } from '../../apps/forge-edge-gateway/src/github';

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
  avatar_url: null, tenant_id: 'ten_1', project_id: 'prj_1'
};

const deferred = {
  id: 'dfr_1', tenant_id: 'ten_1', project_id: 'prj_1', workspace_id: 'ws_1',
  approval_id: 'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa', task_id: null, action: 'work.submit',
  repo_owner: 'octocat', repo_name: 'site', branch: 'forge/fix', base: 'main',
  staged_ref: 'forge/staged/ws_1/fix', commit_sha: 'a'.repeat(40),
  title: 'Fix homepage typo', body: 'Body', summary: '1 file changed', files_changed: 1,
  state: 'awaiting_approval', result: null, error: null,
  created_at: new Date(Date.now() - 45 * 60_000).toISOString(), updated_at: new Date().toISOString(),
  preview_workspace_id: null, preview_state: 'none', preview_id: null,
  preview_expires_at: null, preview_error: null, github_repository_id: '99'
};

function env(approvalState = 'pending') {
  const approval = {
    requested_action: 'work.submit', reason: 'Merge forge/fix into main',
    request_payload: JSON.stringify({ branch: 'forge/fix', base: 'main', title: 'Fix homepage typo', diff: DIFF }),
    state: approvalState, expires_at: new Date(Date.now() + 3_600_000).toISOString()
  };
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

const request = (url: string) => new Request(url, { headers: { cookie: 'forge_session=abc' } });
const APPROVAL_URL = 'https://forge.test/approvals/apr_aaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('reviewer-facing pages', () => {
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

  it('shows the outcome instead of the buttons once decided', async () => {
    const response = await approvalPage(request(APPROVAL_URL), env('approved'), 'apr_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    const html = await response.text();
    expect(html).not.toContain('value="approved"');
    expect(html).toContain('Action approved');
  });

  it('puts the review queue on the dashboard with a way into each item', async () => {
    const response = await appDashboard(request('https://forge.test/app'), env());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Waiting for your review');
    expect(html).toContain('Fix homepage typo');
    expect(html).toContain('/approvals/apr_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    // Approving happens on a phone; keep the tap target at the page's own 44px.
    // Tap targets come from the shared sheet now, so every surface gets them.
    expect(html).toMatch(/\.btn,button\{[^}]*min-height:44px/);
  });
});
