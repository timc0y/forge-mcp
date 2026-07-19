import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import {
  ForgeError,
  ids,
  workspaceIdFromIdempotency,
  type ProcessId,
  type ProjectId,
  type TenantId,
  type WorkspaceId
} from '@forge/core';
import { issueCapability } from '@forge/capabilities';
import { registerForgeToolsV1 } from '@forge/mcp-adapter-v1';
import { forgeToolResponse, type ForgeToolHandlers } from '@forge/mcp-core';
import { R2ArtifactStore } from '@forge/artifacts-r2';
import type { BrowserActionStep } from '@forge/browser-core';
import { selectBrowserProvider } from './browser-router';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import { classifyCommand } from '@forge/policy';
import type { Env } from './env';
import { registerForgeConsole } from './forge-console';
import type { WorkspaceCoordinator } from './workspace-coordinator';
import { reserveWorkspaceSlot, releaseWorkspaceSlot, reclaimStaleSlots, slotTtlMs, workspaceCaps } from './capacity';
import { snapshotsEnabled } from './snapshots';
import { aiEnabled, generateCommitMessage, summarizeDiffForPr } from './ai';
import {
  authorizeRepository,
  completeApproval,
  createDraftPullRequest,
  listAuthorizedRepositories,
  requestApproval,
  requireApproval
} from './github';

interface SessionProps extends Record<string, unknown> {
  subject: string;
  tenantId: string;
  projectId: string;
  clientId: string;
}

// Operator policy: when on, in-workspace shell commands that would otherwise
// need a human click (dependency installs and other gated shell) run without an
// approval round trip. GitHub writes (git push / PR create) are gated on their
// own path and are intentionally NOT covered here.
function autoApproveShell(env: Pick<Env, 'FORGE_AUTO_APPROVE_SHELL'>): boolean {
  return env.FORGE_AUTO_APPROVE_SHELL === 'true' || env.FORGE_AUTO_APPROVE_SHELL === '1';
}

// Roll the per-cell heading-defect signal up to the packet level so a review
// verdict cannot be reached without confronting it: a clean-looking screenshot
// no longer buys silence over structurally broken content.
function summarizeStructure(
  evidence: Array<{ accessibility?: { structure?: { findingCount?: number; countsByKind?: Record<string, number>; truncated?: boolean } }; route?: unknown; environment?: unknown }>
): {
  totalFindings: number;
  affectedCells: number;
  countsByKind: Record<string, number>;
  truncated: boolean;
  routesWithFindings: Array<{ route: unknown; environment: unknown; findingCount: number }>;
} {
  const countsByKind: Record<string, number> = {};
  const routesWithFindings: Array<{ route: unknown; environment: unknown; findingCount: number }> = [];
  let totalFindings = 0;
  let affectedCells = 0;
  let truncated = false;
  for (const cell of evidence) {
    const structure = cell.accessibility?.structure;
    if (!structure) continue;
    const findingCount = structure.findingCount ?? 0;
    if (structure.truncated) truncated = true;
    if (findingCount > 0) {
      totalFindings += findingCount;
      affectedCells += 1;
      routesWithFindings.push({ route: cell.route, environment: cell.environment, findingCount });
      for (const [kind, count] of Object.entries(structure.countsByKind ?? {})) {
        countsByKind[kind] = (countsByKind[kind] ?? 0) + count;
      }
    }
  }
  return { totalFindings, affectedCells, countsByKind, truncated, routesWithFindings };
}

// Bounded-concurrency map that never rejects: the worker owns its errors and
// returns a result for every item, preserving input order. Used to capture
// review cells in parallel (each Browser Run call is seconds long) instead of
// strictly serially, which is the dominant latency cost of the review paths.
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// How many captured screenshots to inline into the tool response. The rest stay
// retrievable via forge_artifact_get, keeping response size (Worker CPU + client
// tokens) bounded on large review grids.
const MAX_INLINE_IMAGES = 4;
// How many screenshots to inline as data: URIs into the widget-only _meta
// gallery. Kept small so the _meta payload (never seen by the model) stays
// bounded on large review grids.
const MAX_GALLERY_IMAGES = 6;
const REVIEW_CAPTURE_CONCURRENCY = 3;

// Roll a single evidence cell's heading-defect count up from its accessibility
// structure signal, so structuredContent can carry a flat findingCount without
// shipping the whole accessibility tree.
function findingCountOf(cell: Record<string, unknown>): number {
  const accessibility = cell.accessibility as { structure?: { findingCount?: number } } | undefined;
  return accessibility?.structure?.findingCount ?? 0;
}

// Map a capture's raw interaction steps to the provider's bounded action vocabulary.
function toActionSteps(
  raw: Array<{ kind: BrowserActionStep['kind']; selector?: string; value?: string; key?: string; text?: string; path?: string; timeout_ms?: number }>
): BrowserActionStep[] {
  return raw.map((step) => {
    switch (step.kind) {
      case 'navigate':
        return { kind: 'navigate', path: String(step.path ?? '/') };
      case 'click':
        return { kind: 'click', selector: String(step.selector) };
      case 'fill':
        return { kind: 'fill', selector: String(step.selector), value: String(step.value ?? '') };
      case 'press':
        return { kind: 'press', key: String(step.key) };
      case 'wait_for_selector':
        return { kind: 'wait_for_selector', selector: String(step.selector), timeoutMs: step.timeout_ms };
      case 'wait_for_text':
        return { kind: 'wait_for_text', text: String(step.text), timeoutMs: step.timeout_ms };
      case 'wait':
        return { kind: 'wait', timeoutMs: step.timeout_ms ?? 1_000 };
      case 'reload':
      default:
        return { kind: 'reload' };
    }
  });
}

function coordinator(env: Env, workspaceId: string): DurableObjectStub<WorkspaceCoordinator> {
  return env.WORKSPACE_COORDINATORS.get(env.WORKSPACE_COORDINATORS.idFromName(workspaceId));
}

// A workspace's (tenant, project) binding is immutable for its lifetime, so a
// verified authorization can be cached to skip the extra getState() DO round
// trip on every subsequent file/git/shell/process call — the highest-frequency
// operations in a coding session. Keyed by the full tuple so it can never
// authorize a different tenant; bounded to stay a fixed-size per-isolate cache.
const authorizedBindings = new Set<string>();
const MAX_AUTHORIZED_BINDINGS = 2_000;

async function authorizedCoordinator(
  env: Env,
  identity: SessionProps,
  workspaceId: string
): Promise<DurableObjectStub<WorkspaceCoordinator>> {
  const value = coordinator(env, workspaceId);
  const key = `${identity.tenantId}:${identity.projectId}:${workspaceId}`;
  if (authorizedBindings.has(key)) return value;
  const state = await value.getState();
  if (state.tenantId !== identity.tenantId || state.projectId !== identity.projectId) {
    throw new ForgeError({
      code: 'FORGE_PERMISSION_DENIED',
      message: 'The workspace is outside the authenticated project.',
      retryable: false
    });
  }
  if (authorizedBindings.size >= MAX_AUTHORIZED_BINDINGS) authorizedBindings.clear();
  authorizedBindings.add(key);
  return value;
}

// Chunked base64 avoids quadratic per-character string building on large buffers.
function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function text(value: unknown): string {
  return String(value);
}

function number(value: unknown): number {
  return Number(value);
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function asRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class ForgeMcpSession extends McpAgent<Env, unknown, SessionProps> {
  server = new McpServer(
    { name: 'Forge MCP', version: '0.1.0' },
    {
      instructions: [
        'Use Forge as a remote development computer and Parallax as the review contract.',
        'For an existing deployed URL, call forge_review first: it returns screenshots without starting a container.',
        'Create one workspace per repository task and reuse its workspace_id.',
        'Read repository instructions and parallax/ files before choosing routes or making changes.',
        'Use forge_review_capture for bounded route and viewport evidence, then call forge_artifact_get and inspect every screenshot used in a finding.',
        'Never claim a multi-step journey passed unless its interactions were executed and recorded.',
        'Inspect the diff and request explicit approval before any future Git push or pull-request action.',
        'Destroy the workspace when the review or coding task is complete.'
      ].join(' ')
    }
  );

  async init(): Promise<void> {
    registerForgeConsole(this.server);
    registerForgeToolsV1(this.server, this.handlers());
    this.registerPrompts();
  }

  // Slash-command style entry points that mirror the server workflow in the
  // instructions block: each prompt renders one concise user turn that steers
  // the model down the intended Forge path (URL review, coding task, draft PR).
  private registerPrompts(): void {
    const userText = (text: string) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }]
    });

    this.server.registerPrompt(
      'review-live-url',
      {
        title: 'Review a live URL',
        description: 'Review an already-deployed URL with Parallax — screenshots without starting a container.',
        argsSchema: {
          url: z.string().describe('The deployed URL to review, e.g. https://example.com'),
          notes: z.string().optional().describe('Optional focus areas, routes or states to prioritise')
        }
      },
      ({ url, notes }) =>
        userText(
          `Review the deployed site at ${url} with Parallax. Call forge_review first (it captures screenshots without starting a container), covering the key routes at phone and desktop viewports. Inspect every returned screenshot before reaching any verdict, and resolve or explicitly accept any structureSummary heading defects.${
            notes ? ` Focus on: ${notes}.` : ''
          }`
        )
    );

    this.server.registerPrompt(
      'start-task',
      {
        title: 'Start a coding task',
        description: 'Start a coding task on an authorized repository in a fresh Forge workspace.',
        argsSchema: {
          repository: z.string().describe('The repository to work in, e.g. owner/name'),
          task: z.string().describe('What the task should accomplish')
        }
      },
      ({ repository, task }) =>
        userText(
          `Start a coding task on ${repository}: ${task}. Create one Forge workspace for this task with forge_workspace_create and reuse its workspace_id, poll forge_workspace_get until it is ready, read the repository instructions and any parallax/ files before making changes, then implement and verify the change. Request explicit approval before any Git push or pull-request action, and destroy the workspace when the task is complete.`
        )
    );

    this.server.registerPrompt(
      'prepare-draft-pr',
      {
        title: 'Prepare a draft PR',
        description: 'Prepare a draft pull request for the current Forge branch once tests pass.',
        argsSchema: {
          workspace_id: z.string().optional().describe('The workspace whose branch should become a draft PR')
        }
      },
      ({ workspace_id }) =>
        userText(
          `Prepare a draft pull request${
            workspace_id ? ` for workspace ${workspace_id}` : ''
          } once the tests pass. First run the tests and confirm they are green, then inspect the outgoing diff with forge_git_outgoing_diff, push the forge/ branch, and create the draft PR — requesting explicit user approval at the push and pull-request steps.`
        )
    );
  }

  private identity(): SessionProps {
    if (this.props?.subject && this.props.tenantId && this.props.projectId) return this.props;
    if (this.env.FORGE_ENVIRONMENT === 'local' || this.env.FORGE_ENVIRONMENT === 'development') {
      return {
        subject: 'dev-user',
        tenantId: this.env.FORGE_DEFAULT_TENANT_ID,
        projectId: this.env.FORGE_DEFAULT_PROJECT_ID,
        clientId: 'development'
      };
    }
    throw new ForgeError({
      code: 'FORGE_AUTH_REQUIRED',
      message: 'Authenticated MCP session context is missing.',
      retryable: false
    });
  }

  // Reclaim stale slots and tear their workspaces down for real. Best-effort:
  // a reaper hiccup must never block a legitimate create. Returns how many slots
  // were freed so the caller can decide whether retrying a reservation is worth
  // it. Only invoked on the contended path, so the common create pays nothing.
  private async reclaimStaleWorkspaceSlots(): Promise<number> {
    const env = this.env;
    try {
      const reclaimed = await reclaimStaleSlots(env.METADATA, slotTtlMs(env), Date.now(), !snapshotsEnabled(env));
      for (const slot of reclaimed) {
        const reapedId = slot.workspaceId as WorkspaceId;
        try {
          const destroyId = workflowInstanceId('destroy', reapedId);
          // Save the workspace before teardown (best-effort, no-op if disabled).
          await coordinator(env, reapedId).snapshotToR2().catch(() => undefined);
          await coordinator(env, reapedId).requestDestroy({ idempotencyKey: `reap-${destroyId}` });
          await env.DESTROY_WORKFLOW.create({
            id: destroyId,
            params: { workspaceId: reapedId, idempotencyKey: `reap-${destroyId}`, preserveArtifacts: true }
          });
        } catch (reapError) {
          // Slot is already freed; teardown of the orphan can lag safely.
          console.warn('forge_slot_reap_teardown_failed', {
            workspaceId: slot.workspaceId,
            reason: reapError instanceof Error ? reapError.message.slice(0, 300) : 'unknown'
          });
        }
      }
      return reclaimed.length;
    } catch (reclaimError) {
      console.warn('forge_slot_reclaim_failed', {
        reason: reclaimError instanceof Error ? reclaimError.message.slice(0, 300) : 'unknown'
      });
      return 0;
    }
  }

  private handlers(): ForgeToolHandlers {
    const env = this.env;
    return {
      forge_repository_list: async () => {
        const identity = this.identity();
        return { repositories: await listAuthorizedRepositories(env, identity.tenantId) };
      },
      forge_review: async (input) => {
        const identity = this.identity();
        const workspaceId = ids.workspace();
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        // Arbitrary-URL review always renders on Cloudflare, never the mini (SSRF guard).
        const browser = await selectBrowserProvider(env, artifacts, identity.tenantId as TenantId, false);
        const captures = input.captures as Array<{ selection?: string; path: string; state: string }>;
        const viewports = input.viewports as Array<{ id: string; width: number; height: number }>;
        const evidence: Array<Record<string, unknown>> = [];
        const failures: Array<Record<string, unknown>> = [];
        const skipped: Array<Record<string, unknown>> = [];
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        // Each (capture × viewport) cell is captured independently so one slow
        // or failing route cannot discard evidence that already succeeded. Cells
        // run with bounded concurrency (Browser Run calls are seconds long) and
        // share a soft deadline so a slow route is skipped rather than lost — the
        // per-cell provider retry is deadline-aware so it stops in step.
        const startedAt = Date.now();
        const deadlineMs = 110_000;
        const deadlineAt = startedAt + deadlineMs;
        const cells = captures.flatMap((capture) => viewports.map((viewport) => ({ capture, viewport })));
        type CellOutcome =
          | { kind: 'evidence'; value: Record<string, unknown>; inline?: { base64: string; contentType: string } }
          | { kind: 'failure'; value: Record<string, unknown> }
          | { kind: 'skipped'; value: Record<string, unknown> };
        const outcomes = await mapWithConcurrency<{ capture: typeof captures[number]; viewport: typeof viewports[number] }, CellOutcome>(
          cells,
          REVIEW_CAPTURE_CONCURRENCY,
          async ({ capture, viewport }) => {
            if (Date.now() >= deadlineAt) {
              return { kind: 'skipped', value: { route: capture.path, environment: viewport.id, reason: 'capture_deadline_reached' } };
            }
            try {
              const result = await browser.captureEvidence({
                workspaceId,
                url: text(input.url),
                path: capture.path,
                viewport: { width: viewport.width, height: viewport.height },
                fullPage: Boolean(input.full_page),
                operationId: ids.operation(),
                workspaceRevision: 1,
                // Public deployed sites: a short cache lets extra viewports of the
                // same route skip a full re-fetch; JPEG keeps evidence small.
                cacheTtlSeconds: 45,
                deadlineAt
              });
              const { inline, ...screenshotRef } = result.screenshot;
              return {
                kind: 'evidence',
                inline,
                value: {
                  selection: capture.selection ?? capture.path,
                  route: capture.path,
                  environment: viewport.id,
                  state: capture.state,
                  requestedViewport: { width: viewport.width, height: viewport.height },
                  observedViewport: { width: result.screenshot.width, height: result.screenshot.height },
                  screenshot: screenshotRef,
                  accessibility: result.accessibility,
                  inspected: false,
                  limitations: ['Static screenshot evidence does not prove interactions that were not executed.']
                }
              };
            } catch (error) {
              return {
                kind: 'failure',
                value: { route: capture.path, environment: viewport.id, reason: error instanceof Error ? error.message.slice(0, 500) : 'Capture failed.' }
              };
            }
          }
        );
        // Widget-only screenshot gallery: small JPEG data: URIs the console can
        // render inline. Reuses the same inline bytes the model receives via
        // MCP content, capped so the _meta payload stays bounded. This never
        // enters structuredContent (base64 stays out of what the model reads).
        const screenshots: Array<{ route: unknown; viewport: unknown; state: unknown; findingCount: number; dataUri: string }> = [];
        for (const outcome of outcomes) {
          if (outcome.kind === 'evidence') {
            evidence.push(outcome.value);
            if (outcome.inline && content.filter((item) => item.type === 'image').length < MAX_INLINE_IMAGES) {
              content.push({ type: 'image', data: outcome.inline.base64, mimeType: outcome.inline.contentType });
            }
            if (outcome.inline && screenshots.length < MAX_GALLERY_IMAGES) {
              screenshots.push({
                route: outcome.value.route,
                viewport: outcome.value.observedViewport ?? outcome.value.requestedViewport,
                state: outcome.value.state,
                findingCount: findingCountOf(outcome.value),
                dataUri: `data:${outcome.inline.contentType};base64,${outcome.inline.base64}`
              });
            }
          } else if (outcome.kind === 'failure') {
            failures.push(outcome.value);
          } else {
            skipped.push(outcome.value);
          }
        }
        if (evidence.length === 0) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'No screenshots could be captured from the requested URL.',
            retryable: true,
            details: { failures, skipped }
          });
        }
        const complete = failures.length === 0 && skipped.length === 0;
        const structureSummary = summarizeStructure(
          evidence as Array<{ accessibility?: { structure?: { findingCount?: number; countsByKind?: Record<string, number>; truncated?: boolean } }; route?: unknown; environment?: unknown }>
        );
        // Concise per-cell rows for structuredContent: what the model needs to
        // reason about the review, with no base64 and no heavy accessibility
        // trees. The full evidence (screenshot refs, accessibility structure)
        // moves into _meta["forge/widget"] for the component to render.
        const evidenceCells = evidence.map((cell) => ({
          selection: cell.selection,
          route: cell.route,
          environment: cell.environment,
          state: cell.state,
          requestedViewport: cell.requestedViewport,
          observedViewport: cell.observedViewport,
          findingCount: findingCountOf(cell),
          inspected: cell.inspected
        }));
        const packet = {
          schemaVersion: 1,
          provider: 'forge',
          executionMode: 'url_review',
          containerUsed: false,
          workspaceId,
          sourceUrl: text(input.url),
          capturedAt: new Date().toISOString(),
          requestedCaptures: cells.length,
          capturedCount: evidence.length,
          complete,
          evidence: evidenceCells,
          failures,
          skipped,
          structureSummary,
          limitations: ['Static screenshot evidence does not prove interactions that were not executed.'],
          inlineImageCount: content.filter((item) => item.type === 'image').length,
          _meta: {
            'forge/widget': {
              schemaVersion: 1,
              executionMode: 'url_review',
              screenshots,
              evidence,
              failures,
              skipped,
              structureSummary
            }
          },
          nextStep: complete
            ? `Inspect the returned MCP images (the first ${MAX_INLINE_IMAGES} cells are inlined; retrieve any others with forge_artifact_get on evidence[].screenshot.artifactId), then pass the evidence to Parallax with inspected set to true.`
            : 'Inspect the returned images, retrieve any others with forge_artifact_get, then re-run forge_review for the routes listed in failures and skipped (fewer routes per call captures more reliably).'
        };
        const structureNote =
          structureSummary.totalFindings > 0
            ? ` Structure health flagged ${structureSummary.totalFindings} heading defect(s) across ${structureSummary.affectedCells} evidence cell(s) (see structureSummary) — resolve or explicitly accept these before passing the review.`
            : '';
        const summary = complete
          ? `Captured ${evidence.length} screenshots without starting a container. Inspect every returned image before marking its evidence inspected.${structureNote}`
          : `Captured ${evidence.length} of ${cells.length} screenshots without starting a container (${failures.length} failed, ${skipped.length} skipped). Inspect the returned images and re-run the remaining routes in smaller batches.${structureNote}`;
        content.unshift({ type: 'text', text: summary });
        return forgeToolResponse(packet, content);
      },
      forge_workspace_create: async (input) => {
        const identity = this.identity();
        const repository = input.repository as { provider: 'github'; owner: string; name: string };
        await authorizeRepository(env, identity, repository);
        const idempotencyKey = text(input.idempotency_key);
        const workspaceId = await workspaceIdFromIdempotency(
          `${identity.tenantId}:${identity.projectId}`,
          idempotencyKey
        );
        // Claim a slot on the fast path with no reaper cost. Only if the claim
        // hits the quota do we reclaim stale slots (missing, terminal, or idle
        // past the TTL), tear those workspaces down, and retry once.
        const caps = workspaceCaps(env);
        try {
          await reserveWorkspaceSlot(env.METADATA, identity.tenantId, workspaceId, caps);
        } catch (reserveError) {
          if (reserveError instanceof ForgeError && reserveError.code === 'FORGE_QUOTA_EXCEEDED') {
            const freed = await this.reclaimStaleWorkspaceSlots();
            if (freed === 0) throw reserveError;
            await reserveWorkspaceSlot(env.METADATA, identity.tenantId, workspaceId, caps);
          } else {
            throw reserveError;
          }
        }
        let result;
        try {
          result = await coordinator(env, workspaceId).initialize({
            workspaceId,
            tenantId: identity.tenantId as TenantId,
            projectId: identity.projectId as ProjectId,
            repository,
            ref: text(input.ref),
            runtimeProfile: text(input.runtime) as
              | 'node-22'
              | 'node-24'
              | 'python-3.13'
              | 'general-purpose',
            persistence: 'ephemeral',
            bootstrap: Boolean(input.bootstrap),
            idempotencyKey,
            actor: { type: 'agent', id: identity.subject }
          });
        } catch (error) {
          // A workspace-ID conflict means an existing live workspace already
          // holds this slot legitimately — releasing it would let the tenant
          // over-admit past its cap. Only release on genuine init failures.
          if (!(error instanceof ForgeError && error.code === 'FORGE_WORKSPACE_CONFLICT')) {
            await releaseWorkspaceSlot(env.METADATA, workspaceId);
          }
          throw error;
        }
        // 'suspended' is recoverable (resume), not terminal — keep its slot.
        if (['failed', 'destroyed'].includes(result.state)) {
          await releaseWorkspaceSlot(env.METADATA, workspaceId);
        }
        if (!result.replay || result.state === 'requested') {
          const workflowId = workflowInstanceId('provision', workspaceId);
          const provisionParams = { workspaceId, bootstrap: Boolean(input.bootstrap) };
          try {
            await env.PROVISION_WORKFLOW.create({ id: workflowId, params: provisionParams });
          } catch (createError) {
            let instance;
            try {
              instance = await env.PROVISION_WORKFLOW.get(workflowId);
            } catch {
              // The instance genuinely could not be reached: nothing is driving
              // provisioning, so release the slot and surface the failure.
              await releaseWorkspaceSlot(env.METADATA, workspaceId);
              throw createError;
            }
            // .get() succeeds even for a DEAD instance. If that instance has
            // reached a terminal state (complete/errored/terminated) but the
            // workspace never reached a live state, the original provisioning
            // died and would never be re-driven — leaving the workspace stuck
            // at 'requested'. Re-drive under a fresh, deterministic instance id
            // (resume-safe: the same idempotency key always derives the same id,
            // so a retried tool call replays onto the same re-drive instance).
            const status = await instance.status().catch(() => undefined);
            const phase = status?.status;
            const terminal = phase === 'complete' || phase === 'errored' || phase === 'terminated';
            const workspaceLive = !['requested', 'provisioning', 'bootstrapping'].includes(result.state);
            if (terminal && !workspaceLive) {
              const nonce = (await sha256(`${idempotencyKey}:provision-redrive`)).slice(0, 12);
              const redriveId = `${workflowId}-r${nonce}`;
              try {
                await env.PROVISION_WORKFLOW.create({ id: redriveId, params: provisionParams });
              } catch (redriveError) {
                // A prior re-drive already exists (resume-safe replay of this
                // same tool call). Only fail if it cannot be found at all.
                try {
                  await env.PROVISION_WORKFLOW.get(redriveId);
                } catch {
                  await releaseWorkspaceSlot(env.METADATA, workspaceId);
                  throw redriveError;
                }
              }
            }
            // Otherwise the instance is still running: keep swallowing, the
            // in-flight workflow will drive provisioning to completion.
          }
        }
        return {
          workspace_id: workspaceId,
          state: result.state,
          operation_id: result.operationId,
          workspace_revision: result.revision
        };
      },
      forge_workspace_get: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).getState());
      },
      forge_files_tree: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).filesTree({
          path: text(input.path),
          depth: number(input.depth),
          limit: number(input.limit)
        }));
      },
      forge_files_read: async (input) => {
        const identity = this.identity();
        const paths = Array.isArray(input.paths) && input.paths.length > 0
          ? (input.paths as unknown[]).map((value) => text(value))
          : input.path !== undefined
            ? [text(input.path)]
            : [];
        if (paths.length === 0) {
          throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Provide a path or a non-empty paths array.', retryable: false });
        }
        const workspace = await authorizedCoordinator(env, identity, text(input.workspace_id));
        const readOne = {
          startLine: optionalNumber(input.start_line),
          endLine: optionalNumber(input.end_line),
          maxBytes: number(input.max_bytes)
        };
        // Single path keeps the original flat shape; multiple returns a files
        // array with per-file errors so one missing file does not fail the batch.
        if (paths.length === 1) {
          return asRecord(await workspace.filesRead({ path: paths[0] as string, ...readOne }));
        }
        const files = await Promise.all(
          paths.map(async (path) => {
            try {
              return { ...(await workspace.filesRead({ path, ...readOne })), path };
            } catch (error) {
              return { path, error: error instanceof ForgeError ? error.code : 'FORGE_READ_FAILED', message: error instanceof Error ? error.message.slice(0, 300) : 'Read failed.' };
            }
          })
        );
        return { files };
      },
      forge_files_write: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).filesWrite({
          path: text(input.path),
          content: text(input.content),
          expectedSha256: input.expected_sha256 ? text(input.expected_sha256) : undefined,
          idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_files_patch: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).filesPatch({
          patch: text(input.patch),
          idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_shell_exec: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const command = text(input.command);
        const cwd = text(input.cwd);
        const networkPolicy = text(input.network_policy) as never;
        const workspace = await authorizedCoordinator(env, identity, workspaceId);
        const decision = classifyCommand(command, networkPolicy);
        const approvalId = input.approval_id ? text(input.approval_id) : undefined;
        const environment = input.environment as Record<string, string>;
        const environmentHash = await sha256(JSON.stringify(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))));
        const approvalPayload = { command, cwd, networkPolicy, environmentHash };
        let claimedApproval = false;
        if (decision.allowed && decision.approvalRequired) {
          if (autoApproveShell(env)) {
            // Operator policy auto-approves gated shell (installs etc.). No token
            // dance; GitHub writes are gated on their own path and unaffected.
            claimedApproval = true;
          } else if (!approvalId) {
            const approval = await requestApproval(env, identity, workspaceId, 'shell.exec', `Run ${decision.classification} command`, approvalPayload);
            throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'Open the Forge approval URL, approve this exact command, then retry with approval_id.', retryable: false, details: approval });
          } else {
            await requireApproval(env, identity, approvalId, workspaceId, 'shell.exec', approvalPayload);
            claimedApproval = true;
          }
        }
        try {
          const result = await workspace.shellExec({
            command,
            cwd,
            timeoutMs: number(input.timeout_ms),
            environment,
            networkPolicy,
            outputLimitBytes: number(input.output_limit_bytes),
            expectedRevision: optionalNumber(input.expected_revision),
            idempotencyKey: text(input.idempotency_key),
            approved: claimedApproval
          });
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, true);
          return asRecord(result);
        } catch (error) {
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_process_start: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).processStart({
          command: text(input.command),
          cwd: text(input.cwd),
          environment: input.environment as Record<string, string>,
          networkPolicy: text(input.network_policy) as never,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_process_logs: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).processLogs({
          processId: text(input.process_id) as ProcessId,
          cursor: input.cursor ? text(input.cursor) : undefined
        }));
      },
      forge_git_status: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).gitStatus());
      },
      forge_git_diff: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).gitDiff({
          staged: Boolean(input.staged)
        }));
      },
      forge_git_branch_create: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).gitBranchCreate({
          branch: text(input.branch), expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_git_commit: async (input) => {
        const identity = this.identity();
        const coordinator = await authorizedCoordinator(env, identity, text(input.workspace_id));
        let message = input.message === undefined ? '' : text(input.message);
        // Blank message + AI on: synthesise a commit message from the working
        // diff. Best-effort — generateCommitMessage never throws, and if the
        // diff is empty we leave the message blank so gitCommit enforces the
        // existing required-message contract.
        if (!message.trim() && aiEnabled(env)) {
          const diff = await coordinator.gitDiff({ staged: false }).then((r) => r.stdout ?? '').catch(() => '');
          if (diff.trim()) message = await generateCommitMessage(env, diff);
        }
        return asRecord(await coordinator.gitCommit({
          message, paths: input.paths as string[], expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_git_outgoing_diff: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).gitOutgoingDiff({ base: text(input.base) }));
      },
      forge_git_push: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const branch = text(input.branch);
        const base = text(input.base);
        const diffHash = text(input.expected_diff_hash);
        const approvalId = input.approval_id ? text(input.approval_id) : undefined;
        if (!approvalId) {
          // Attach the actual outgoing diff so the human approves what they can
          // see, not an opaque hash. Best-effort — `diff` is display-only; the
          // diffHash remains the integrity check enforced by requireApproval.
          const outgoing = await (await authorizedCoordinator(env, identity, workspaceId))
            .gitOutgoingDiff({ base }).catch(() => undefined);
          const approval = await requestApproval(env, identity, workspaceId, 'git.push', `Push ${branch} to GitHub`, { branch, base, diffHash, diff: outgoing?.diff ?? '' });
          throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'Open the Forge approval URL, approve this exact push, then retry with approval_id.', retryable: false, details: approval });
        }
        await requireApproval(env, identity, approvalId, workspaceId, 'git.push', { branch, base, diffHash });
        try {
          const result = await (await authorizedCoordinator(env, identity, workspaceId)).gitPush({
            branch, base, expectedDiffHash: diffHash, expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: text(input.idempotency_key)
          });
          await completeApproval(env, approvalId, true);
          return asRecord(result);
        } catch (error) {
          await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_pull_request_create: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const head = text(input.head);
        const base = text(input.base);
        let title = input.title === undefined ? '' : text(input.title);
        let body = input.body === undefined ? '' : text(input.body);
        const approvalId = input.approval_id ? text(input.approval_id) : undefined;
        // Blank title + AI on: summarise the branch diff into a title (and body
        // only when the caller left the body blank too). Best-effort — the
        // summariser never throws; if AI is disabled we keep prior behaviour.
        if (!title.trim() && aiEnabled(env)) {
          const outgoing = await (await authorizedCoordinator(env, identity, workspaceId))
            .gitOutgoingDiff({ base }).catch(() => undefined);
          if (outgoing?.diff?.trim()) {
            const summary = await summarizeDiffForPr(env, outgoing.diff, { branch: head, base });
            title = summary.title;
            if (!body.trim()) body = summary.body;
          }
        }
        if (!approvalId) {
          // Show the branch's diff on the approval page so the PR is reviewed on
          // its contents, not just a title. Display-only, best-effort.
          const outgoing = await (await authorizedCoordinator(env, identity, workspaceId))
            .gitOutgoingDiff({ base }).catch(() => undefined);
          const approval = await requestApproval(env, identity, workspaceId, 'pull_request.create', `Create draft pull request ${head} → ${base}`, { head, base, title, body, diff: outgoing?.diff ?? '' });
          throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'Open the Forge approval URL, approve this draft PR, then retry with approval_id.', retryable: false, details: approval });
        }
        await requireApproval(env, identity, approvalId, workspaceId, 'pull_request.create', { head, base, title, body });
        try {
          const state = await (await authorizedCoordinator(env, identity, workspaceId)).getState();
          const result = await createDraftPullRequest(env, identity, state.repository, { head, base, title, body });
          await completeApproval(env, approvalId, true);
          return result;
        } catch (error) {
          await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_preview_expose: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const value = await (await authorizedCoordinator(env, identity, workspaceId)).previewExpose({
          processId: text(input.process_id) as ProcessId,
          port: number(input.port),
          hostname: env.FORGE_PREVIEW_HOSTNAME,
          access: text(input.access) as never,
          ttlSeconds: number(input.ttl_seconds),
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key)
        });
        if ('replay' in value) return asRecord(value);
        const now = Math.floor(Date.now() / 1000);
        const capability = await issueCapability(
          {
            version: 1,
            subject: identity.subject,
            tenantId: identity.tenantId,
            workspaceId,
            action: `preview:${value.previewId}`,
            nonce: crypto.randomUUID(),
            issuedAt: now,
            expiresAt: Math.floor(new Date(value.expiresAt).getTime() / 1000)
          },
          env.FORGE_CAPABILITY_SIGNING_KEY
        );
        return {
          ...value,
          preview_url: `${env.FORGE_PUBLIC_ORIGIN}/preview/${workspaceId}/${value.previewId}/`,
          preview_capability: capability,
          preview_capability_header: 'x-forge-preview-capability'
        };
      },
      forge_review_capture: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const previewId = text(input.preview_id);
        const detail = await (await authorizedCoordinator(env, identity, workspaceId)).getPreviewInternal(previewId);
        if (new Date(detail.preview.expiresAt).getTime() <= Date.now()) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'Preview has expired.',
            retryable: false
          });
        }
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        const browser = await selectBrowserProvider(env, artifacts, detail.workspace.tenantId);
        const captures = input.captures as Array<{ selection?: string; route: string; state: string; steps?: Array<{ kind: BrowserActionStep['kind']; selector?: string; value?: string; key?: string; text?: string; path?: string; timeout_ms?: number }> }>;
        const viewports = input.viewports as Array<{ id: string; width: number; height: number }>;
        const startedAt = Date.now();
        const deadlineAt = startedAt + 110_000;
        const cells = captures.flatMap((capture) => viewports.map((viewport) => ({ capture, viewport })));
        // Capture cells in parallel with per-cell error isolation, so one failed
        // route no longer throws away the whole packet (the old serial loop did).
        const captured = await mapWithConcurrency<{ capture: typeof captures[number]; viewport: typeof viewports[number] }, Record<string, unknown> | { failure: Record<string, unknown> }>(
          cells,
          REVIEW_CAPTURE_CONCURRENCY,
          async ({ capture, viewport }) => {
            try {
              const browserInput = {
                workspaceId,
                url: `${env.FORGE_PUBLIC_ORIGIN}/__forge_browser/${workspaceId}/${previewId}/`,
                path: capture.route,
                headers: {
                  'x-forge-internal-preview': env.FORGE_INTERNAL_PREVIEW_KEY,
                  'x-forge-browser-workspace': workspaceId,
                  'x-forge-browser-preview': previewId
                },
                viewport: { width: viewport.width, height: viewport.height },
                fullPage: false,
                operationId: ids.operation(),
                repositoryCommit: detail.workspace.currentCommit,
                workspaceRevision: detail.workspace.revision,
                deadlineAt
              };
              // With steps, drive the interaction then capture (proves a flow);
              // without, a single static capture.
              const result = capture.steps && capture.steps.length > 0
                ? await browser.act({ ...browserInput, steps: toActionSteps(capture.steps) })
                : await browser.captureEvidence(browserInput);
              const { inline: _inline, ...screenshotRef } = result.screenshot;
              return {
                selection: capture.selection ?? capture.route,
                route: capture.route,
                environment: viewport.id,
                state: capture.state,
                requestedViewport: { width: viewport.width, height: viewport.height },
                observedViewport: { width: result.screenshot.width, height: result.screenshot.height },
                screenshot: screenshotRef,
                accessibility: result.accessibility,
                // Audit trail: the exact interaction this evidence proves, so a
                // Parallax reviewer can see what was actually done, not just the
                // resulting frame.
                executedSteps: capture.steps ?? null,
                inspected: false,
                limitations: []
              };
            } catch (error) {
              return { failure: { route: capture.route, environment: viewport.id, reason: error instanceof Error ? error.message.slice(0, 500) : 'Capture failed.' } };
            }
          }
        );
        const evidence = captured.filter((cell): cell is Record<string, unknown> => !('failure' in cell));
        const failures = captured.filter((cell): cell is { failure: Record<string, unknown> } => 'failure' in cell).map((cell) => cell.failure);
        if (evidence.length === 0) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'No screenshots could be captured from the preview.',
            retryable: true,
            details: { failures }
          });
        }
        return {
          schemaVersion: 1,
          provider: 'forge',
          workspaceId,
          repository: `${detail.workspace.repository.owner}/${detail.workspace.repository.name}`,
          commit: detail.workspace.currentCommit,
          workspaceRevision: detail.workspace.revision,
          capturedAt: new Date().toISOString(),
          previewId,
          evidence,
          failures,
          structureSummary: summarizeStructure(
            evidence as Array<{ accessibility?: { structure?: { findingCount?: number; countsByKind?: Record<string, number>; truncated?: boolean } }; route?: unknown; environment?: unknown }>
          ),
          limitations: [],
          nextStep: 'Call forge_artifact_get for each evidence[].screenshot.artifactId, inspect the image, then mark that evidence inspected in Parallax. Resolve or explicitly accept any structureSummary heading defects before passing the review.'
        };
      },
      forge_artifact_get: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const artifactId = text(input.artifact_id);
        // A container-backed workspace has a coordinator record that binds it to
        // the caller's tenant and project. A URL-review workspace (from
        // forge_review) has no coordinator, so its artifacts are only reachable
        // through the tenant-scoped R2 key. Fall back to that path when — and
        // only when — no coordinator record exists, so real cross-project
        // workspaces still fail the authorization check above.
        let workspaceRevision: number | null = null;
        let source: 'workspace' | 'url_review' = 'workspace';
        const state = await coordinator(env, workspaceId).tryGetState();
        if (state) {
          if (state.tenantId !== identity.tenantId || state.projectId !== identity.projectId) {
            throw new ForgeError({
              code: 'FORGE_PERMISSION_DENIED',
              message: 'The workspace is outside the authenticated project.',
              retryable: false
            });
          }
          workspaceRevision = state.revision;
        } else {
          source = 'url_review';
        }
        const object = await env.ARTIFACTS.get(
          `tenant/${identity.tenantId}/workspace/${workspaceId}/artifacts/${artifactId}`
        );
        if (!object) {
          throw new ForgeError({
            code: 'FORGE_ARTIFACT_NOT_FOUND',
            message: 'Artifact was not found in this workspace.',
            retryable: false
          });
        }
        const maxBytes = number(input.max_bytes);
        if (object.size > maxBytes) {
          throw new ForgeError({
            code: 'FORGE_OUTPUT_TRUNCATED',
            message: 'Artifact is larger than the requested output limit.',
            retryable: false,
            details: { sizeBytes: object.size, maxBytes }
          });
        }
        const mimeType = object.httpMetadata?.contentType ?? 'application/octet-stream';
        const value = {
          artifact_id: artifactId,
          workspace_id: workspaceId,
          workspace_revision: workspaceRevision,
          source,
          content_type: mimeType,
          size_bytes: object.size,
          metadata: object.customMetadata ?? {}
        };
        if (!mimeType.startsWith('image/')) return value;
        return forgeToolResponse(value, [{
          type: 'image',
          data: base64(await object.arrayBuffer()),
          mimeType
        }]);
      },
      forge_workspace_destroy: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const idempotencyKey = text(input.idempotency_key);
        const request = await (await authorizedCoordinator(env, identity, workspaceId)).requestDestroy({
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey
        });
        if (request.state !== 'destroyed') {
          const workflowId = workflowInstanceId('destroy', workspaceId);
          try {
            await env.DESTROY_WORKFLOW.create({
              id: workflowId,
              params: {
                workspaceId,
                idempotencyKey,
                preserveArtifacts: Boolean(input.preserve_artifacts)
              }
            });
          } catch {
            await env.DESTROY_WORKFLOW.get(workflowId);
          }
        }
        return {
          workspace_id: workspaceId,
          state: request.state,
          operation_id: request.operationId,
          workspace_revision: request.workspaceRevision,
          replay: request.replay
        };
      }
    };
  }
}
