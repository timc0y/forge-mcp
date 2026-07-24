import { ForgeError, ids, type ProjectId, type TenantId, type WorkspaceId } from '@forge/core';
import { issueCapability } from '@forge/capabilities';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import { reserveWorkspaceSlot, releaseWorkspaceSlot, workspaceCaps } from './capacity';
import type { DeferredAction } from './deferred-actions';
import type { Env } from './env';

/**
 * A live preview of staged work, built only when a reviewer asks for one.
 *
 * The reviewer wants to click through the running app before approving. Keeping
 * a container warm for every submission would be expensive, and would re-couple
 * approval to workspace lifetime — the coupling deferred actions exist to break.
 * So this provisions a fresh workspace *from the staged commit* on demand, runs
 * the project's detected dev server, and exposes it. It is torn down by the
 * ordinary idle reaper once the reviewer stops using it.
 *
 * The state machine is driven by polling from the approval page rather than held
 * open in a request: provisioning a container takes far longer than a sensible
 * HTTP timeout.
 */

export type ReviewPreviewState = 'none' | 'provisioning' | 'starting' | 'ready' | 'failed';

export interface ReviewPreviewStatus {
  state: ReviewPreviewState;
  url?: string;
  expiresAt?: string;
  error?: string;
  /** Cookie value the browser needs to reach the preview, set once when ready. */
  capability?: string;
  previewPath?: string;
}

const PREVIEW_TTL_SECONDS = 3600;

async function setPreview(
  env: Env,
  id: string,
  fields: {
    state: ReviewPreviewState;
    workspaceId?: string | null;
    previewId?: string | null;
    expiresAt?: string | null;
    error?: string | null;
  }
): Promise<void> {
  await env.METADATA.prepare(
    `UPDATE deferred_actions
        SET preview_state=?1,
            preview_workspace_id=COALESCE(?2, preview_workspace_id),
            preview_id=?3, preview_expires_at=?4, preview_error=?5, updated_at=?6
      WHERE id=?7`
  ).bind(
    fields.state,
    fields.workspaceId ?? null,
    fields.previewId ?? null,
    fields.expiresAt ?? null,
    fields.error ?? null,
    new Date().toISOString(),
    id
  ).run();
}

interface PreviewRow {
  preview_workspace_id: string | null;
  preview_state: string;
  preview_id: string | null;
  preview_expires_at: string | null;
  preview_error: string | null;
}

async function previewRow(env: Env, id: string): Promise<PreviewRow | null> {
  return env.METADATA.prepare(
    'SELECT preview_workspace_id, preview_state, preview_id, preview_expires_at, preview_error FROM deferred_actions WHERE id=?1'
  ).bind(id).first<PreviewRow>();
}

/**
 * Start provisioning a preview workspace checked out at the staged ref.
 *
 * Idempotent: a second click while one is already coming up is a no-op, so an
 * impatient reviewer cannot burn several workspace slots on one submission.
 */
export async function launchReviewPreview(
  env: Env,
  action: DeferredAction,
  coordinatorFor: (env: Env, workspaceId: string) => {
    initialize: (input: Record<string, unknown>) => Promise<{ state: string }>;
  }
): Promise<ReviewPreviewStatus> {
  const existing = await previewRow(env, action.id);
  if (existing && ['provisioning', 'starting', 'ready'].includes(existing.preview_state)) {
    return { state: existing.preview_state as ReviewPreviewState };
  }

  const workspaceId = ids.workspace();
  const caps = workspaceCaps(env);
  try {
    await reserveWorkspaceSlot(env.METADATA, action.tenantId, workspaceId, caps);
  } catch (error) {
    const message = error instanceof ForgeError && error.code === 'FORGE_QUOTA_EXCEEDED'
      ? 'No workspace slots are free right now. Destroy an idle workspace, or approve on the diff alone.'
      : 'Could not reserve a workspace for the preview.';
    await setPreview(env, action.id, { state: 'failed', error: message });
    return { state: 'failed', error: message };
  }

  try {
    // Check out the staging ref itself: it is an ordinary branch pointing at
    // exactly the commit under review, so the preview shows the reviewer the
    // code they are being asked to approve — not the tip of the target branch.
    await coordinatorFor(env, workspaceId).initialize({
      workspaceId,
      tenantId: action.tenantId as TenantId,
      projectId: action.projectId as ProjectId,
      repository: action.repository,
      ref: action.stagedRef,
      runtimeProfile: 'node-22',
      persistence: 'ephemeral',
      bootstrap: true,
      idempotencyKey: `review-preview-${action.id}`,
      actor: { type: 'user', id: 'review-preview' }
    });
    await env.PROVISION_WORKFLOW.create({
      id: workflowInstanceId('provision', workspaceId),
      params: { workspaceId, bootstrap: true }
    });
  } catch (error) {
    await releaseWorkspaceSlot(env.METADATA, workspaceId).catch(() => undefined);
    const message = error instanceof Error ? error.message.slice(0, 300) : 'unknown error';
    await setPreview(env, action.id, { state: 'failed', error: message });
    return { state: 'failed', error: message };
  }

  await setPreview(env, action.id, { state: 'provisioning', workspaceId });
  return { state: 'provisioning' };
}

/**
 * Advance and report the preview state machine. Called by the approval page's
 * poll: provisioning → starting (container ready, bringing the dev server up) →
 * ready (URL live) or failed.
 */
export async function reviewPreviewStatus(
  env: Env,
  action: DeferredAction,
  coordinatorFor: (env: Env, workspaceId: string) => {
    getState: () => Promise<{ state: string }>;
    startReviewPreview: (input: { hostname: string; ttlSeconds: number }) => Promise<
      { ready: true; previewId: string; port: number; expiresAt: string } | { ready: false; reason: string }
    >;
  }
): Promise<ReviewPreviewStatus> {
  const row = await previewRow(env, action.id);
  if (!row || row.preview_state === 'none') return { state: 'none' };
  if (row.preview_state === 'failed') return { state: 'failed', error: row.preview_error ?? undefined };
  const workspaceId = row.preview_workspace_id;
  if (!workspaceId) return { state: 'none' };

  // A ready preview that has since expired drops back to 'none' so the reviewer
  // can simply launch a new one.
  if (row.preview_state === 'ready' && row.preview_id) {
    if (row.preview_expires_at && Date.parse(row.preview_expires_at) <= Date.now()) {
      await setPreview(env, action.id, { state: 'none' });
      return { state: 'none' };
    }
    return {
      state: 'ready',
      ...(await readyPayload(env, action, workspaceId, row.preview_id, row.preview_expires_at ?? ''))
    };
  }

  const coordinator = coordinatorFor(env, workspaceId);
  const state = await coordinator.getState().catch(() => null);
  if (!state) return { state: 'provisioning' };
  if (['failed', 'destroyed'].includes(state.state)) {
    const message = `The preview workspace ${state.state}.`;
    await setPreview(env, action.id, { state: 'failed', error: message });
    return { state: 'failed', error: message };
  }
  if (state.state !== 'ready') return { state: 'provisioning' };

  const started = await coordinator
    .startReviewPreview({ hostname: env.FORGE_PREVIEW_HOSTNAME, ttlSeconds: PREVIEW_TTL_SECONDS })
    .catch((error: unknown) => ({ ready: false as const, reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));

  if (!started.ready) {
    // "No dev server" is terminal — polling will never fix it. Anything else is
    // just the server still coming up, so keep the reviewer waiting rather than
    // failing them out of a preview that is seconds away.
    if (started.reason.includes('no dev server command')) {
      await setPreview(env, action.id, { state: 'failed', error: started.reason });
      return { state: 'failed', error: started.reason };
    }
    await setPreview(env, action.id, { state: 'starting', workspaceId });
    return { state: 'starting' };
  }

  await setPreview(env, action.id, {
    state: 'ready',
    workspaceId,
    previewId: started.previewId,
    expiresAt: started.expiresAt
  });
  return { state: 'ready', ...(await readyPayload(env, action, workspaceId, started.previewId, started.expiresAt)) };
}

/**
 * The preview proxy authenticates with a signed capability, normally sent as a
 * header by an agent. A browser cannot set headers on a plain navigation, so the
 * capability is handed back here for the caller to store in a path-scoped,
 * HttpOnly cookie — never in the URL, which would leak it into history, logs and
 * any copy-pasted link.
 */
async function readyPayload(
  env: Env,
  action: DeferredAction,
  workspaceId: string,
  previewId: string,
  expiresAt: string
): Promise<{ url: string; expiresAt: string; capability: string; previewPath: string }> {
  const now = Math.floor(Date.now() / 1000);
  const expiry = expiresAt ? Math.floor(Date.parse(expiresAt) / 1000) : now + PREVIEW_TTL_SECONDS;
  const capability = await issueCapability(
    {
      version: 1,
      subject: `review:${action.id}`,
      tenantId: action.tenantId,
      workspaceId: workspaceId as WorkspaceId,
      action: `preview:${previewId}`,
      nonce: crypto.randomUUID(),
      issuedAt: now,
      expiresAt: expiry
    },
    env.FORGE_CAPABILITY_SIGNING_KEY
  );
  const previewPath = `/preview/${workspaceId}/${previewId}/`;
  return {
    url: `${env.FORGE_PUBLIC_ORIGIN}${previewPath}`,
    expiresAt,
    capability,
    previewPath
  };
}
