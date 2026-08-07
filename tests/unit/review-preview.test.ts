import { describe, expect, it, vi } from 'vitest';
import {
  launchReviewPreview,
  releaseReviewPreview,
  reviewPreviewStatus
} from '../../apps/forge-edge-gateway/src/review-preview';
import type { DeferredAction } from '../../apps/forge-edge-gateway/src/deferred-actions';
import type { Env } from '../../apps/forge-edge-gateway/src/env';

type PreviewFields = {
  preview_workspace_id: string | null;
  preview_state: string;
  preview_id: string | null;
  preview_expires_at: string | null;
  preview_error: string | null;
};

// In-memory stand-in for the single deferred_actions row under test.
function fakeEnv(row: PreviewFields) {
  const env = {
    FORGE_PUBLIC_ORIGIN: 'https://forge.test',
    FORGE_PREVIEW_HOSTNAME: 'preview.forge.test',
    FORGE_CAPABILITY_SIGNING_KEY: 'k'.repeat(48),
    METADATA: {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...args: unknown[]) {
            values = args;
            return statement;
          },
          async first<T>(): Promise<T | null> {
            if (sql.includes('SELECT preview_workspace_id')) return row as unknown as T;
            throw new Error(`unexpected first(): ${sql}`);
          },
          async run() {
            if (sql.includes('SET preview_state=?1')) {
              row.preview_state = String(values[0]);
              // ?7 is the clearWorkspace flag (1 clears, else COALESCE-style keep/set).
              if (values[6] === 1) row.preview_workspace_id = null;
              else if (values[1] !== null) row.preview_workspace_id = String(values[1]);
              row.preview_id = values[2] === null ? null : String(values[2]);
              row.preview_expires_at = values[3] === null ? null : String(values[3]);
              row.preview_error = values[4] === null ? null : String(values[4]);
              return { meta: { changes: 1 } };
            }
            throw new Error(`unexpected run(): ${sql}`);
          }
        };
        return statement;
      }
    }
  };
  return env as unknown as Env;
}

const action = {
  id: 'dfr_1',
  tenantId: 'ten_a',
  projectId: 'prj_a',
  workspaceId: 'ws_origin',
  approvalId: 'apr_a',
  taskId: null,
  action: 'work.submit',
  repository: { provider: 'github', owner: 'acme', name: 'app' },
  branch: 'forge/fix',
  base: 'main',
  stagedRef: 'forge/staged/ws_origin/fix',
  commitSha: 'a'.repeat(40),
  title: 'Fix',
  body: '',
  summary: '',
  filesChanged: 1,
  state: 'awaiting_approval',
  result: null,
  error: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
} as DeferredAction;

function stubFor(
  workspaceState: string,
  preview: { ready: true; previewId: string; port: number; expiresAt: string } | { ready: false; reason: string }
) {
  const startReviewPreview = vi.fn(async () => preview);
  return {
    factory: () => ({ getState: async () => ({ state: workspaceState }), startReviewPreview }) as never,
    startReviewPreview
  };
}

const fresh = (): PreviewFields => ({
  preview_workspace_id: null,
  preview_state: 'none',
  preview_id: null,
  preview_expires_at: null,
  preview_error: null
});

describe('review preview (on-demand, at approval time)', () => {
  it('reports nothing until a reviewer asks for one', async () => {
    const row = fresh();
    const stub = stubFor('ready', { ready: true, previewId: 'prv_1', port: 3000, expiresAt: '' });
    expect(await reviewPreviewStatus(fakeEnv(row), action, stub.factory)).toEqual({ state: 'none' });
    // Crucially, no container was touched just by opening the approval page.
    expect(stub.startReviewPreview).not.toHaveBeenCalled();
  });

  it('does not burn a second workspace when the reviewer clicks twice', async () => {
    const row = { ...fresh(), preview_state: 'provisioning', preview_workspace_id: 'ws_preview' };
    const initialize = vi.fn();
    const status = await launchReviewPreview(fakeEnv(row), action, (() => ({ initialize })) as never);
    expect(status.state).toBe('provisioning');
    expect(initialize).not.toHaveBeenCalled();
  });

  it('waits while the container comes up, then goes ready with a URL', async () => {
    const row = { ...fresh(), preview_state: 'provisioning', preview_workspace_id: 'ws_preview' };
    const env = fakeEnv(row);

    const provisioning = stubFor('provisioning', { ready: false, reason: 'not ready' });
    expect((await reviewPreviewStatus(env, action, provisioning.factory)).state).toBe('provisioning');
    expect(provisioning.startReviewPreview).not.toHaveBeenCalled();

    const booting = stubFor('ready', { ready: false, reason: 'preview is still starting' });
    expect((await reviewPreviewStatus(env, action, booting.factory)).state).toBe('starting');

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const live = stubFor('ready', { ready: true, previewId: 'prv_9', port: 5173, expiresAt });
    const ready = await reviewPreviewStatus(env, action, live.factory);
    expect(ready.state).toBe('ready');
    expect(ready.url).toBe('https://forge.test/preview/ws_preview/prv_9/');
    // The capability travels as a cookie value, never in the URL.
    expect(ready.capability).toBeTruthy();
    expect(ready.url).not.toContain(ready.capability!);
  });

  it('gives up honestly when the project has no dev server', async () => {
    const row = { ...fresh(), preview_state: 'provisioning', preview_workspace_id: 'ws_preview' };
    const env = fakeEnv(row);
    const stub = stubFor('ready', { ready: false, reason: 'no dev server command was detected for this project' });
    const status = await reviewPreviewStatus(env, action, stub.factory);
    expect(status.state).toBe('failed');
    expect(status.error).toContain('no dev server command');
    // Terminal: polling again must not silently flip back to "starting".
    expect((await reviewPreviewStatus(env, action, stub.factory)).state).toBe('failed');
  });

  it('fails immediately when repository preview configuration is invalid', async () => {
    const row = { ...fresh(), preview_state: 'provisioning', preview_workspace_id: 'ws_preview' };
    const stub = stubFor('ready', { ready: false, reason: 'Forge config preview.port must be an integer from 1024 to 65535.' });
    const status = await reviewPreviewStatus(fakeEnv(row), action, stub.factory);
    expect(status.state).toBe('failed');
    expect(status.error).toContain('Forge config');
    expect((await reviewPreviewStatus(fakeEnv(row), action, stub.factory)).state).toBe('failed');
    expect(stub.startReviewPreview).toHaveBeenCalledTimes(1);
  });

  it('surfaces a workspace that died rather than polling forever', async () => {
    const row = { ...fresh(), preview_state: 'provisioning', preview_workspace_id: 'ws_preview' };
    const stub = stubFor('failed', { ready: false, reason: 'n/a' });
    const status = await reviewPreviewStatus(fakeEnv(row), action, stub.factory);
    expect(status.state).toBe('failed');
    expect(status.error).toContain('failed');
  });

  it('gives the workspace slot back once the submission is decided', async () => {
    const row: PreviewFields = {
      preview_workspace_id: 'ws_preview',
      preview_state: 'ready',
      preview_id: 'prv_1',
      preview_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      preview_error: null
    };
    const env = fakeEnv(row);
    const destroy = vi.fn(async () => undefined);
    await releaseReviewPreview(env, action.id, destroy);
    // A preview exists only to inform the decision; holding one of the tenant's
    // few slots for hours afterwards would starve the agent still working.
    expect(destroy).toHaveBeenCalledWith('ws_preview');
    expect(row.preview_state).toBe('none');
    expect(row.preview_workspace_id).toBeNull();
  });

  it('still tears down when preview_state was soft-cleared to none', async () => {
    // Regression: expiry used to set state=none without destroy; a later release
    // then returned early and left the slot orphaned.
    const row: PreviewFields = {
      preview_workspace_id: 'ws_orphaned',
      preview_state: 'none',
      preview_id: null,
      preview_expires_at: null,
      preview_error: null
    };
    const destroy = vi.fn(async () => undefined);
    await releaseReviewPreview(fakeEnv(row), action.id, destroy);
    expect(destroy).toHaveBeenCalledWith('ws_orphaned');
    expect(row.preview_workspace_id).toBeNull();
  });

  it('destroys the preview workspace when its TTL lapses', async () => {
    const row: PreviewFields = {
      preview_workspace_id: 'ws_preview',
      preview_state: 'ready',
      preview_id: 'prv_1',
      preview_expires_at: new Date(Date.now() - 1_000).toISOString(),
      preview_error: null
    };
    const destroyCalls: string[] = [];
    const env = {
      ...fakeEnv(row),
      WORKSPACE_COORDINATORS: {
        idFromName: (id: string) => id,
        get: () => ({
          requestDestroy: async () => {
            destroyCalls.push('requestDestroy');
          }
        })
      },
      DESTROY_WORKFLOW: {
        create: async () => {
          destroyCalls.push('workflow');
        }
      }
    } as unknown as Env;
    const status = await reviewPreviewStatus(env, action, stubFor('ready', {
      ready: true, previewId: 'prv_1', port: 3000, expiresAt: row.preview_expires_at!
    }).factory);
    expect(status.state).toBe('none');
    expect(row.preview_state).toBe('none');
    expect(row.preview_workspace_id).toBeNull();
    expect(destroyCalls).toEqual(['requestDestroy', 'workflow']);
  });

  it('is a no-op when no preview was ever launched', async () => {
    const destroy = vi.fn(async () => undefined);
    await releaseReviewPreview(fakeEnv(fresh()), action.id, destroy);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('never lets a teardown failure escape into the decision', async () => {
    const row = { ...fresh(), preview_state: 'ready', preview_workspace_id: 'ws_preview' };
    const destroy = vi.fn(async () => { throw new Error('container already gone'); });
    await expect(releaseReviewPreview(fakeEnv(row), action.id, destroy)).resolves.toBeUndefined();
  });

  it('lets an expired preview be launched again', async () => {
    const row: PreviewFields = {
      preview_workspace_id: 'ws_preview',
      preview_state: 'ready',
      preview_id: 'prv_old',
      preview_expires_at: new Date(Date.now() - 1000).toISOString(),
      preview_error: null
    };
    const stub = stubFor('ready', { ready: true, previewId: 'prv_old', port: 3000, expiresAt: '' });
    expect((await reviewPreviewStatus(fakeEnv(row), action, stub.factory)).state).toBe('none');
  });
});
