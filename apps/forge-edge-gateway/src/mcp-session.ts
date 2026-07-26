import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import {
  ForgeError,
  toForgeError,
  ids,
  workspaceIdFromIdempotency,
  type ProcessId,
  type CredentialProfileId,
  type ProjectId,
  type SecretId,
  type TenantId,
  type WorkspaceId
} from '@forge/core';
import { issueCapability } from '@forge/capabilities';
import { registerForgeToolsV1, type ToolCallTelemetry } from '@forge/mcp-adapter-v1';
import { ToolCallTracker, hashArgs } from './telemetry';
import { forgeToolResponse, type ForgeToolHandlers } from '@forge/mcp-core';
import { R2ArtifactStore } from '@forge/artifacts-r2';
import { D1TaskStore } from '@forge/metadata-d1';
import { D1AuditStore } from '@forge/audit';
import { createPushEnvelope, findActiveEnvelope, recordEnvelopePush, pathsWithinEnvelope } from './push-envelopes';
import { elicitInlineApproval } from './inline-approval';
import type { ForgeEvent } from '@forge/events';
import { analyzeDiff, selectContext, suggestChecks } from '@forge/insight';
import {
  applyTaskPatch,
  assertTaskOwnership,
  assertTaskTransition,
  isTerminalTaskState,
  createTask,
  summarizeTask,
  hasBlockingCompletionGaps,
  type RepositoryRef,
  type TaskId,
  type TaskState,
  type TaskHandoff
} from '@forge/task-core';
import type { BrowserActionStep } from '@forge/browser-core';
import { selectBrowserProvider } from './browser-router';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import { classifyCommand, assertPublicHost } from '@forge/policy';
import { normalizeViewports, prepareInlineImages } from './review-images';
import { resolveWorkspaceId } from './workspace-resolve';
import { storeGallery } from './review-gallery';
import type { CommandClass } from '@forge/policy';
import type { Env } from './env';
import type { WorkspaceCoordinator } from './workspace-coordinator';
import { credentialService } from './credentials';
import { vaultService } from './vault';
import { reserveWorkspaceSlot, releaseWorkspaceSlot, reclaimStaleSlots, listSlotOccupants, slotTtlMs, workspaceCaps } from './capacity';
import { snapshotsEnabled } from './snapshots';
import { aiEnabled, generateCommitMessage, summarizeDiffForPr } from './ai';
import { registerLegacyWidgetStub } from './legacy-widget';
import {
  authorizeRepository,
  completeApproval,
  createDraftPullRequest,
  listAuthorizedRepositories,
  repositoryAccessDiagnosis,
  markApprovalApproved,
  requestApproval,
  requireApproval
} from './github';
import { createDeferredAction, listDeferredActionsForWorkspace } from './deferred-actions';

interface SessionProps extends Record<string, unknown> {
  subject: string;
  tenantId: string;
  projectId: string;
  clientId: string;
}

const SELECTED_CREDENTIAL_PROFILE_KEY = 'selected-credential-profile';

// Operator policy: when on, in-workspace shell commands that would otherwise
// need a human click (dependency installs and other gated shell) run without an
// approval round trip. GitHub writes (git push / PR create) are gated on their
// own path and are intentionally NOT covered here.
function autoApproveShell(env: Pick<Env, 'FORGE_AUTO_APPROVE_SHELL'>): boolean {
  return env.FORGE_AUTO_APPROVE_SHELL === 'true' || env.FORGE_AUTO_APPROVE_SHELL === '1';
}

// Which gated (allowed && approvalRequired) shell classes the operator auto-approve
// flag is permitted to silently approve.
//
// Defaults to dependency installs plus `requires_approval`. The latter no longer
// means "this command contains a pipe" — since the segment-aware classifier landed
// it means only "this line could not be parsed at all" (unbalanced quotes,
// pathological nesting), which is a parser limitation rather than a signal of
// risk, and is squarely the kind of thing an operator who has opted into
// auto-approve is opting into.
//
// Operators can widen or narrow this with FORGE_AUTO_APPROVE_SHELL_CLASSES (a
// comma-separated list). `destructive` is deliberately NOT in the default set:
// `rm -rf` and `git reset --hard` throw away work that may not exist anywhere
// else yet. Network egress under `unrestricted_with_approval` can never be
// auto-approved at all, regardless of this setting — see mayAutoApproveShell.
const DEFAULT_AUTO_APPROVABLE_SHELL_CLASSES: readonly CommandClass[] = ['dependency_install', 'requires_approval'];

const KNOWN_SHELL_CLASSES: ReadonlySet<string> = new Set<CommandClass>([
  'read_only', 'local_mutation', 'dependency_install', 'network_access',
  'external_side_effect', 'privileged', 'destructive', 'prohibited', 'requires_approval'
]);

function autoApprovableShellClasses(env: Pick<Env, 'FORGE_AUTO_APPROVE_SHELL_CLASSES'>): ReadonlySet<CommandClass> {
  const configured = (env.FORGE_AUTO_APPROVE_SHELL_CLASSES ?? '').trim();
  if (!configured) return new Set(DEFAULT_AUTO_APPROVABLE_SHELL_CLASSES);
  const parsed = configured
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => KNOWN_SHELL_CLASSES.has(entry)) as CommandClass[];
  // An unparseable or fully-bogus setting falls back to the default rather than
  // to "auto-approve nothing" (silent friction) or "everything" (silent risk).
  return parsed.length > 0 ? new Set(parsed) : new Set(DEFAULT_AUTO_APPROVABLE_SHELL_CLASSES);
}

// True only when the operator flag is on AND the command is a low-risk gated
// class AND the caller is not asking for the unrestricted_with_approval network
// policy (which always demands a human even for an otherwise auto-approvable
// class).
function mayAutoApproveShell(
  env: Pick<Env, 'FORGE_AUTO_APPROVE_SHELL' | 'FORGE_AUTO_APPROVE_SHELL_CLASSES'>,
  classification: CommandClass,
  networkPolicy: string
): boolean {
  if (!autoApproveShell(env)) return false;
  if (networkPolicy === 'unrestricted_with_approval') return false;
  return autoApprovableShellClasses(env).has(classification);
}

// A url_review workspace (from forge_review) has no WorkspaceCoordinator record,
// so its artifacts would otherwise be authorized purely by R2 key shape. Bind the
// generated workspaceId to its owning (tenant, project) at creation so
// forge_artifact_get can assert real ownership, not just a well-formed key.
// Requires the url_review_workspaces(workspace_id PK, tenant_id, project_id,
// created_at) table (delegated migration). Best-effort: a write failure (e.g.
// table not yet migrated) must never break a legitimate review capture.
async function recordUrlReviewOwner(
  env: Pick<Env, 'METADATA'>,
  workspaceId: string,
  tenantId: string,
  projectId: string
): Promise<void> {
  try {
    await env.METADATA.prepare(
      `INSERT INTO url_review_workspaces (workspace_id, tenant_id, project_id, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(workspace_id) DO NOTHING`
    ).bind(workspaceId, tenantId, projectId, new Date().toISOString()).run();
  } catch (error) {
    console.warn('forge_url_review_binding_write_failed', {
      workspaceId,
      reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
    });
  }
}

// Assert the caller owns a url_review workspace before its artifacts are read.
// Returns the recorded (tenant, project) when a binding exists so the caller can
// distinguish "verified owner" from "no binding on record". If a binding row
// exists it is authoritative — a tenant/project mismatch is denied outright.
async function lookupUrlReviewOwner(
  env: Pick<Env, 'METADATA'>,
  workspaceId: string
): Promise<{ tenantId: string; projectId: string } | null> {
  try {
    const row = await env.METADATA.prepare(
      'SELECT tenant_id AS tenant_id, project_id AS project_id FROM url_review_workspaces WHERE workspace_id = ?1'
    ).bind(workspaceId).first<{ tenant_id: string; project_id: string }>();
    if (!row) return null;
    return { tenantId: row.tenant_id, projectId: row.project_id };
  } catch (error) {
    // Table not migrated yet, or a transient DB error: fall back to the
    // (already tenant-scoped) R2 key path rather than failing every read.
    console.warn('forge_url_review_binding_read_failed', {
      workspaceId,
      reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
    });
    return null;
  }
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
      message: 'This workspace belongs to a different project. Use a workspace_id from the current project.',
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Paging inputs shared by the two diff tools. The cursor is an opaque string on
 * the wire (so its meaning can change without a schema break) but a file index
 * underneath; anything unparseable falls back to the first page rather than
 * erroring, since a bad cursor should never be a dead end.
 */
/**
 * The change's true scale, for an approval page that may only be able to render
 * part of the diff. Kept separate from the attached text so the headline figures
 * never shrink just because the diff was paged.
 */
function diffTotals(
  page: { totalFiles: number; totalAdditions: number; totalDeletions: number } | undefined
): { files: number; additions: number; deletions: number } | undefined {
  return page && { files: page.totalFiles, additions: page.totalAdditions, deletions: page.totalDeletions };
}

function diffPaging(input: Record<string, unknown>): { cursor?: number; maxBytes?: number; paths?: string[] } {
  const parsed = input.cursor === undefined ? Number.NaN : Number.parseInt(String(input.cursor), 10);
  const paths = Array.isArray(input.paths)
    ? input.paths.map((path) => String(path)).filter((path) => path && !path.startsWith('/') && !path.includes('..') && !path.includes('\0'))
    : undefined;
  return {
    ...(Number.isFinite(parsed) && parsed > 0 ? { cursor: parsed } : {}),
    ...(input.max_bytes === undefined ? {} : { maxBytes: Number(input.max_bytes) }),
    ...(paths?.length ? { paths } : {})
  };
}

/**
 * Idempotency key for a mutating call, minted when the caller did not supply one.
 *
 * The key exists so a caller that retries after a dropped connection does not
 * apply the same mutation twice — genuinely useful, and worth keeping. But it was
 * *required* on every mutating tool, which made the common case (one call, no
 * retry) pay for the rare one, and pushed models into inventing keys and then
 * accidentally reusing them, turning a real second command into a silent replay.
 *
 * Omitting it now means "no retry protection for this call", which is the honest
 * default: a fresh random key can never collide, so the call always executes. A
 * caller that wants replay safety still passes its own stable key and gets
 * exactly the previous behaviour.
 */
function idempotency(value: unknown): string {
  return value === undefined || value === null || value === '' ? crypto.randomUUID() : String(value);
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
        'Forge is a remote development computer; Parallax is its review contract. Work in this order:',
        '1. Need to see a live URL? Call forge_review — one call, no container, no polling, and the screenshots come back attached to the result. A url on its own captures it at phone and desktop; add captures for more routes. This is the right tool for any "what does this look like" question.',
        '2. Starting a coding task? Call forge_task_start before creating a workspace, then create one workspace per task and reuse its workspace_id. forge_workspace_create waits for the workspace to be usable and returns it ready, so never build a polling loop around it.',
        '3. Before choosing routes or making changes, read the repository instructions and any parallax/ files.',
        '4. Screenshots come back attached to forge_review and forge_review_capture — look at those images directly and never claim a finding you have not seen. Only reach for forge_artifact_get when a result says captures were omitted; if a grid is too big to return at once, prefer re-running with fewer routes or one viewport.',
        '5. Never claim a multi-step journey passed unless its interactions were actually executed and recorded.',
        '6. Inspect the diff, then finish with forge_submit_for_review — it stages the work and queues the pull request for a human to approve in their own time. Never wait for a human: say the work is submitted and where to review it. Use forge_git_push / forge_pull_request_create only when the caller explicitly wants to block on an approval right now.',
        '7. Destroy the workspace once the task or review is complete — submitted work is staged off-box and survives teardown.'
      ].join(' ')
    }
  );

  async init(): Promise<void> {
    // Resolves the retired widget URI to an empty document. No tool advertises
    // it; this exists only so sessions opened before the widget was removed
    // stop rendering an unresolved placeholder. See legacy-widget.ts.
    registerLegacyWidgetStub(this.server);
    const tracker = new ToolCallTracker(this.env, {
      waitUntil: (p) => (this.ctx as unknown as { waitUntil?: (p: Promise<unknown>) => void })?.waitUntil?.(p)
    });
    registerForgeToolsV1(this.server, this.handlers(), (event) => {
      void this.onToolCallTelemetry(tracker, event);
    });
    this.registerPrompts();
  }

  private async onToolCallTelemetry(tracker: ToolCallTracker, event: ToolCallTelemetry): Promise<void> {
    let identity: SessionProps;
    try {
      identity = this.identity();
    } catch {
      return;
    }
    let clientName: string | undefined;
    try {
      clientName = (this.server as unknown as { server?: { getClientVersion?: () => { name?: string } | undefined } })
        .server?.getClientVersion?.()?.name;
    } catch {
      clientName = undefined;
    }
    tracker.capture(
      {
        tool: event.tool,
        distinctId: identity.tenantId,
        sessionId: `${identity.tenantId}:${identity.projectId}`,
        clientName,
        durationMs: event.durationMs,
        status: event.status,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        resultBytes: event.resultBytes,
        argsHash: await hashArgs(event.input)
      },
      Date.now()
    );
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
          `Review the deployed site at ${url} with Parallax. Call forge_review first — it captures screenshots without starting a container — covering the key routes at phone and desktop viewports. Inspect every returned screenshot before reaching a verdict, and resolve or explicitly accept any structureSummary heading defects.${
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
          `Start a coding task on ${repository}: ${task}. Create one Forge workspace for this task with forge_workspace_create and reuse its workspace_id, poll forge_workspace_get until it is ready, then read the repository instructions and any parallax/ files before making changes. Implement and verify the change, inspect the outgoing diff, then finish with forge_submit_for_review — it stages the work and queues the pull request for review, so do not wait for anyone. Tell me it is submitted and where to approve it, then destroy the workspace.`
        )
    );

    this.server.registerPrompt(
      'prepare-draft-pr',
      {
        title: 'Submit work for review',
        description: 'Stage the current Forge branch and queue its draft pull request for review, without waiting for an approval.',
        argsSchema: {
          workspace_id: z.string().optional().describe('The workspace whose branch should become a draft PR')
        }
      },
      ({ workspace_id }) =>
        userText(
          `Submit the current work for review${
            workspace_id ? ` in workspace ${workspace_id}` : ''
          } once tests pass. Run the tests and confirm they are green, inspect the outgoing diff with forge_git_outgoing_diff, then call forge_submit_for_review. It stages the branch and queues the draft pull request for me to approve whenever I get to it, so do not block waiting for an approval — report that it is submitted, tell me where to review it, and destroy the workspace.`
        )
    );
  }

  // Append-only "what actually happened" trail for the handful of mutating,
  // consequential actions (push, PR create, task finish, workspace destroy) —
  // deliberately best-effort and never blocks the action it records. This is
  // what lets a later reviewer reconcile an agent's self-reported task
  // summary against reality, rather than only having the agent's own account.
  private async recordAudit(
    type: string,
    tenantId: string,
    payload: Record<string, unknown>,
    extra?: { workspaceId?: string }
  ): Promise<void> {
    const event: ForgeEvent = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      tenantId: tenantId as TenantId,
      workspaceId: extra?.workspaceId as WorkspaceId | undefined,
      actor: { type: 'agent', id: this.props?.subject ?? 'forge-mcp' },
      type,
      occurredAt: new Date().toISOString(),
      payload
    };
    await new D1AuditStore(this.env.METADATA).append(event).catch((error) => {
      console.error('forge_audit_append_failed', {
        type,
        name: error instanceof Error ? error.name : 'unknown'
      });
    });
  }

  // Best-effort inline layer on top of an already-minted (pending) approval:
  // try MCP URL-mode elicitation so a supporting client can render the
  // approve/decline prompt inline instead of the agent pasting a link into
  // chat text. Returns the approval id to proceed with immediately when the
  // human accepted inline; returns null for every other outcome (unsupported
  // client, decline, cancel, timeout), in which case the caller should fall
  // back to its normal "open this URL and retry" error unchanged.
  private async tryResolveApprovalInline(
    identity: SessionProps,
    approval: { approval_id: string; approval_url: string; expires_at: string; already_approved: boolean },
    reason: string
  ): Promise<string | null> {
    if (approval.already_approved) return null;
    const outcome = await elicitInlineApproval(this.server, approval.approval_id, reason, approval.approval_url)
      .catch(() => 'unsupported' as const);
    if (outcome !== 'accept') return null;
    const marked = await markApprovalApproved(this.env, identity.tenantId, approval.approval_id);
    return marked ? approval.approval_id : null;
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
      message: 'No authenticated session was found. Reconnect with a valid Forge session before calling any tool.',
      retryable: false
    });
  }

  private async selectedCredentialProfileId(identity: SessionProps): Promise<CredentialProfileId | undefined> {
    const selected = await this.ctx.storage.get<string>(SELECTED_CREDENTIAL_PROFILE_KEY);
    const profiles = await credentialService(this.env).list(identity.tenantId as TenantId);
    if (selected && profiles.some((profile) => profile.id === selected)) return selected as CredentialProfileId;
    const active = profiles.find((profile) => profile.active);
    if (active) await this.ctx.storage.put(SELECTED_CREDENTIAL_PROFILE_KEY, active.id);
    return active?.id;
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
          // Two independent backup attempts before teardown — see the
          // equivalent block in index.ts's reapAbandonedSlots for why (an
          // R2 snapshot can silently come back near-empty, so a fast direct
          // push to a Forge-owned backup ref is tried first, and a destroy
          // that proceeds with neither having worked is logged loudly).
          const backup: { pushed: boolean; ref?: string; reason?: string } = await coordinator(env, reapedId).backupUnpushedWork().catch((error) => ({
            pushed: false,
            reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
          }));
          const snapshot = await coordinator(env, reapedId).snapshotToR2().catch(() => null);
          if (backup.pushed || snapshot) {
            console.log('forge_slot_reap_backup', { workspaceId: reapedId, backupPushed: backup.pushed, backupRef: backup.ref, snapshotted: Boolean(snapshot) });
          } else if (backup.reason !== 'nothing to back up') {
            console.error('forge_slot_reap_destroy_without_backup', { workspaceId: reapedId, tenantId: slot.tenantId, backupReason: backup.reason });
            await new D1AuditStore(env.METADATA).append({
              schemaVersion: 1,
              id: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
              tenantId: slot.tenantId as TenantId,
              workspaceId: reapedId,
              actor: { type: 'service', id: 'idle-reaper' },
              type: 'workspace.reap_destroy_without_backup',
              occurredAt: new Date().toISOString(),
              payload: { reason: backup.reason }
            }).catch(() => undefined);
          }
          // force: true — reclaimStaleSlots already gated dirty-workspace
          // eligibility on snapshotsEnabled above.
          await coordinator(env, reapedId).requestDestroy({ idempotencyKey: `reap-${destroyId}`, force: true });
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

  private async loadTask(taskId: TaskId) {
    const task = await new D1TaskStore(this.env.METADATA).get(taskId);
    if (!task) {
      throw new ForgeError({
        code: 'FORGE_TASK_NOT_FOUND',
        message: 'No task exists with this task_id. List tasks with forge_task_list to find a valid id.',
        retryable: false,
        details: { taskId }
      });
    }
    return task;
  }

  private handlers(): ForgeToolHandlers {
    const env = this.env;
    return {
      forge_capabilities: async () => ({
        workspace: { explicit_workspace_id_required: true, filesystem_read_after_write: 'verified_by_forge_files_write', durable_checkpoints: true },
        git: { immutable_base_commit: true, workspace_proof: true, branch_push: 'approval_required', draft_pull_request: 'approval_required', direct_merge: 'disabled' },
        processes: { managed_status: true, persistent_logs: true, preview_requires_exact_process_id: true },
        deployment: { cloudflare_wrangler: 'approval_required_with_validated_profile' },
        recovery: { checkpoint: true, destruction_with_uncommitted_or_unpushed_work: 'blocked' }
      }),
      forge_credential_list: async () => {
        const identity = this.identity();
        const selectedCredentialProfileId = await this.selectedCredentialProfileId(identity);
        return { profiles: await credentialService(env).list(identity.tenantId as TenantId), selected_credential_profile_id: selectedCredentialProfileId ?? null };
      },
      forge_credential_create: async (input) => {
        const identity = this.identity();
        const profile = await credentialService(env).create({
          tenantId: identity.tenantId as TenantId,
          name: text(input.name), provider: 'cloudflare', secret: text(input.secret),
          metadata: input.metadata as Record<string, string>, active: Boolean(input.make_active)
        });
        if (profile.active) await this.ctx.storage.put(SELECTED_CREDENTIAL_PROFILE_KEY, profile.id);
        return { profile };
      },
      forge_credential_update: async (input) => {
        const identity = this.identity();
        const profile = await credentialService(env).update(identity.tenantId as TenantId, text(input.credential_profile_id) as CredentialProfileId, {
          ...(input.name === undefined ? {} : { name: text(input.name) }),
          ...(input.secret === undefined ? {} : { secret: text(input.secret) }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata as Record<string, string> }),
          ...(input.make_active === undefined ? {} : { active: Boolean(input.make_active) })
        });
        if (profile.active) await this.ctx.storage.put(SELECTED_CREDENTIAL_PROFILE_KEY, profile.id);
        return { profile };
      },
      forge_credential_delete: async (input) => {
        const identity = this.identity();
        const profileId = text(input.credential_profile_id) as CredentialProfileId;
        await credentialService(env).delete(identity.tenantId as TenantId, profileId);
        if (await this.ctx.storage.get<string>(SELECTED_CREDENTIAL_PROFILE_KEY) === profileId) await this.ctx.storage.delete(SELECTED_CREDENTIAL_PROFILE_KEY);
        return { deleted_credential_profile_id: profileId };
      },
      forge_credential_switch: async (input) => {
        const identity = this.identity();
        const profile = await credentialService(env).setActive(identity.tenantId as TenantId, text(input.credential_profile_id) as CredentialProfileId);
        await this.ctx.storage.put(SELECTED_CREDENTIAL_PROFILE_KEY, profile.id);
        return { profile, selected_credential_profile_id: profile.id };
      },
      forge_credential_validate: async (input) => {
        const identity = this.identity();
        const profile = await credentialService(env).validate(identity.tenantId as TenantId, text(input.credential_profile_id) as CredentialProfileId);
        return { profile };
      },
      forge_secret_list: async () => {
        const identity = this.identity();
        const [secrets, attachments] = await Promise.all([
          vaultService(env).list(identity.tenantId as TenantId),
          vaultService(env).attachedSecrets(identity.tenantId as TenantId)
        ]);
        return { secrets, attached: attachments };
      },
      forge_secret_create: async (input) => {
        const identity = this.identity();
        const secret = await vaultService(env).create(
          identity.tenantId as TenantId,
          text(input.label), input.provider as 'cloudflare' | 'shopify' | 'generic',
          input.env as Record<string, string>
        );
        return { secret };
      },
      forge_secret_update: async (input) => {
        const identity = this.identity();
        const secret = await vaultService(env).update(
          identity.tenantId as TenantId, text(input.secret_id) as SecretId,
          {
            ...(input.label === undefined ? {} : { label: text(input.label) }),
            ...(input.provider === undefined ? {} : { provider: input.provider as 'cloudflare' | 'shopify' | 'generic' }),
            ...(input.env === undefined ? {} : { env: input.env as Record<string, string> })
          }
        );
        return { secret };
      },
      forge_secret_delete: async (input) => {
        const identity = this.identity();
        await vaultService(env).delete(identity.tenantId as TenantId, text(input.secret_id) as SecretId);
        return { deleted_secret_id: text(input.secret_id) };
      },
      forge_secret_attach: async (input) => {
        const identity = this.identity();
        const secretId = text(input.secret_id) as SecretId;
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const approvalId = input.approval_id ? text(input.approval_id) : undefined;
        if (!approvalId) {
          const secret = (await vaultService(env).list(identity.tenantId as TenantId)).find(
            (s) => s.id === secretId
          );
          const varNames = secret?.varNames.join(', ') ?? 'unknown';
          const approval = await requestApproval(env, identity, workspaceId, 'secret.attach',
            `Attach secret "${secret?.label ?? secretId}" to workspace ${workspaceId}`,
            { secret_id: secretId, workspace_id: workspaceId, var_names: varNames }
          );
          if (approval.already_approved) {
            await vaultService(env).attach(identity.tenantId as TenantId, secretId, workspaceId);
            return { attached: true, secret_id: secretId, workspace_id: workspaceId };
          }
          throw new ForgeError({
            code: 'FORGE_APPROVAL_REQUIRED', message: 'This attach needs human approval. Open the approval URL, approve it, then retry with approval_id.',
            retryable: false, details: { kind: 'approval', action: 'secret.attach', ...approval }
          });
        }
        await requireApproval(env, identity, approvalId, workspaceId, 'secret.attach',
          { secret_id: secretId, workspace_id: workspaceId }
        );
        await vaultService(env).attach(identity.tenantId as TenantId, secretId, workspaceId);
        await completeApproval(env, approvalId, true);
        return { attached: true, secret_id: secretId, workspace_id: workspaceId };
      },
      forge_secret_detach: async (input) => {
        const identity = this.identity();
        const secretId = text(input.secret_id) as SecretId;
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        await vaultService(env).detach(identity.tenantId as TenantId, secretId, workspaceId);
        return { detached: true, secret_id: secretId, workspace_id: workspaceId };
      },
      forge_workspace_reconcile: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, text(input.workspace_id));
        return asRecord(await workspace.reconcile());
      },
      forge_workspace_prove: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).proveWorkspaceState());
      },
      forge_workspace_checkpoint: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).checkpoint({
          ...(input.name === undefined ? {} : { name: text(input.name) })
        }));
      },
      forge_workspace_restore: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).restoreCheckpoint({
          snapshotId: text(input.snapshot_id), expectedRevision: optionalNumber(input.expected_revision)
        }));
      },
      forge_work_export: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id) as WorkspaceId;
        const exported = await (await authorizedCoordinator(env, identity, workspaceId)).exportRecoveryPatch({ maxBytes: number(input.max_bytes) });
        const artifactId = ids.artifact();
        const bytes = new TextEncoder().encode(exported.content).buffer;
        const artifact = await new R2ArtifactStore(env.ARTIFACTS).put({
          id: artifactId, tenantId: identity.tenantId as TenantId, workspaceId,
          kind: 'recovery.patch', contentType: 'text/plain; charset=utf-8', bytes,
          metadata: { base_commit: String(exported.proof.observed.baseCommit ?? ''), head_commit: String(exported.proof.observed.commit ?? ''), branch: String(exported.proof.observed.branch ?? '') }
        });
        return { workspace_id: workspaceId, recovery_artifact: artifact, proof: exported.proof, restore: 'Use the matching Forge checkpoint to restore untracked files and process state.' };
      },
      forge_cloudflare_deploy: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const profileId = (input.credential_profile_id ? text(input.credential_profile_id) : await this.selectedCredentialProfileId(identity)) as CredentialProfileId | undefined;
        if (!profileId) throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Select a Cloudflare credential profile before deploying.', retryable: false });
        const environment = input.environment === undefined ? undefined : text(input.environment);
        const configPath = input.config_path === undefined ? undefined : text(input.config_path);
        const command = `pnpm exec wrangler deploy${configPath ? ` --config ${shellQuote(configPath)}` : ''}${environment ? ` --env ${shellQuote(environment)}` : ''}`;
        const payload = { profileId, command, environment: environment ?? null, configPath: configPath ?? null };
        const approvalId = input.approval_id ? text(input.approval_id) : undefined;
        if (!approvalId) {
          const approval = await requestApproval(env, identity, workspaceId, 'shell.exec', 'Deploy this workspace with Cloudflare Wrangler; repository-controlled code receives the token for this one command.', payload);
          throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'Open the Forge approval URL, approve this exact Cloudflare deployment, then retry with approval_id.', retryable: false, details: approval });
        }
        await requireApproval(env, identity, approvalId, workspaceId, 'shell.exec', payload);
        try {
          const result = await credentialService(env).withSecret(identity.tenantId as TenantId, profileId, async (profile, secret) => {
            if (profile.provider !== 'cloudflare') throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Only Cloudflare credential profiles can deploy with Wrangler.', retryable: false });
            if (profile.state !== 'valid') throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Validate this Cloudflare credential profile before deploying.', retryable: false });
            const value = await (await authorizedCoordinator(env, identity, workspaceId)).shellExec({
              command, cwd: '/workspace/repo', timeoutMs: 900_000,
              environment: { CLOUDFLARE_API_TOKEN: secret, ...(profile.metadata.account_id ? { CLOUDFLARE_ACCOUNT_ID: profile.metadata.account_id } : {}) },
              networkPolicy: 'development', outputLimitBytes: 200_000,
              expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: text(input.idempotency_key), approved: true
            });
            const stdout = 'stdout' in value ? String(value.stdout ?? '') : '';
            const stderr = 'stderr' in value ? String(value.stderr ?? '') : '';
            return { ...value, stdout: stdout.replaceAll(secret, '[REDACTED]'), stderr: stderr.replaceAll(secret, '[REDACTED]') };
          });
          await completeApproval(env, approvalId, true);
          return asRecord(result);
        } catch (error) {
          await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_repository_list: async () => {
        const identity = this.identity();
        const repositories = await listAuthorizedRepositories(env, identity.tenantId);
        if (repositories.length > 0) return { repositories };
        // An empty list reads as "Forge is broken" unless it says otherwise. Tell
        // the caller which of the several very different reasons this is, and
        // exactly where the human has to click, so it can pass that on instead of
        // reporting a dead end.
        const diagnosis = await repositoryAccessDiagnosis(env, identity.tenantId);
        return {
          repositories,
          reason: diagnosis.state,
          next_step: `${diagnosis.detail} Ask the account owner to open ${diagnosis.installUrl} and connect the repositories — no repository work is possible until they do.`
        };
      },
      forge_task_start: async (input) => {
        const identity = this.identity();
        const store = new D1TaskStore(env.METADATA);
        const task = createTask(ids.task(), new Date().toISOString(), {
          tenantId: identity.tenantId as TenantId,
          projectId: identity.projectId as ProjectId,
          repository: input.repository as RepositoryRef,
          baseRef: text(input.base_ref),
          goal: text(input.goal),
          decisions: input.decisions as string[],
          nonGoals: input.non_goals as string[],
          likelyPaths: input.likely_paths as string[]
        });
        await store.put(task);
        return { task_id: task.id, state: task.state, revision: task.revision, container_used: false };
      },
      forge_task_get: async (input) => {
        const identity = this.identity();
        const task = await this.loadTask(text(input.task_id) as TaskId);
        assertTaskOwnership(task, { tenantId: identity.tenantId as TenantId });
        return asRecord(task);
      },
      forge_task_summary: async (input) => {
        const identity = this.identity();
        const task = await this.loadTask(text(input.task_id) as TaskId);
        assertTaskOwnership(task, { tenantId: identity.tenantId as TenantId });
        const summary = summarizeTask(task);
        // No per-workspace deadline is tracked, but the slot TTL is the real
        // ceiling on how long an idle workspace survives — surface it so an
        // agent whose tool access is about to end can push/checkpoint instead
        // of being cut off mid-verification with no warning (see incident:
        // work committed but never pushed before the session ended).
        const ttlMinutes = Math.round(slotTtlMs(env) / 60_000);
        return asRecord({
          ...summary,
          sessionBudget: {
            workspaceIdleTtlMinutes: ttlMinutes,
            note: task.workspaceId
              ? `An idle workspace is reclaimed after ~${ttlMinutes} minutes of inactivity. Push the forge/ branch and call forge_task_finish before then, or send any tool call to reset the idle clock.`
              : 'No workspace attached yet.'
          }
        });
      },
      forge_task_handoff: async (input) => {
        const identity = this.identity();
        const store = new D1TaskStore(env.METADATA);
        const task = await this.loadTask(text(input.task_id) as TaskId);
        assertTaskOwnership(task, { tenantId: identity.tenantId as TenantId });
        const handoff: TaskHandoff = {
          summary: text(input.summary),
          nextSteps: (input.next_steps as string[]) ?? [],
          ...(input.key_learnings ? { keyLearnings: input.key_learnings as string[] } : {}),
          ...(input.modified_files ? { modifiedFiles: input.modified_files as string[] } : {}),
          ...(input.blocked_by ? { blockedBy: text(input.blocked_by) } : {}),
          createdAt: new Date().toISOString(),
          authorAgent: 'chatgpt'
        };
        task.handoff = handoff;
        task.updatedAt = new Date().toISOString();
        task.revision += 1;
        await store.put(task);
        return {
          task_id: task.id,
          recorded: true,
          handoff_created_at: handoff.createdAt,
          next_step: 'Handoff recorded. Call forge_task_resume in any fresh ChatGPT session to pick up work immediately.'
        };
      },
      forge_task_resume: async (input) => {
        const identity = this.identity();
        const task = await this.loadTask(text(input.task_id) as TaskId);
        assertTaskOwnership(task, { tenantId: identity.tenantId as TenantId });
        let workspaceState: Record<string, unknown> | null = null;
        let gitSummary: Record<string, unknown> | null = null;
        const targetWorkspaceId = input.workspace_id ? text(input.workspace_id) : task.workspaceId;
        if (targetWorkspaceId) {
          try {
            const workspace = await authorizedCoordinator(env, identity, targetWorkspaceId);
            const state = await workspace.getState();
            workspaceState = {
              workspaceId: state.id,
              state: state.state,
              currentBranch: state.currentBranch,
              hasUnpushedWork: state.hasUnpushedWork
            };
            const status = await workspace.gitStatus();
            gitSummary = {
              clean: status.clean,
              branch: status.branch,
              hasUnpushedWork: status.hasUnpushedWork
            };
          } catch {
            // Best effort workspace lookup
          }
        }
        const summary = summarizeTask(task);
        const compact = input.compact !== false;
        return {
          task: compact
            ? {
                id: task.id,
                goal: summary.goal,
                state: task.state,
                branch: summary.branch,
                handoff: task.handoff,
                nextRecommendedAction: summary.nextRecommendedAction,
                knownLimitations: summary.knownLimitations,
                outstanding: summary.outstanding,
                filesChanged: summary.filesChanged
              }
            : summary,
          workspace: workspaceState,
          git: gitSummary,
          handoff: task.handoff ?? null,
          next_step: task.handoff?.nextSteps?.[0] ?? summary.nextRecommendedAction
        };
      },
      forge_context_pack: async (input) => {
        const identity = this.identity();
        const goal = text(input.goal);
        const repository = input.repository as { provider: 'github'; owner: string; name: string };
        const maxTokens = input.max_tokens ? number(input.max_tokens) : 4000;
        let fileList: string[] = [];
        if (input.paths && Array.isArray(input.paths) && input.paths.length > 0) {
          fileList = (input.paths as string[]).map((p) => text(p));
        } else {
          try {
            const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
            const tree = await (await authorizedCoordinator(env, identity, workspaceId)).filesTree({
              path: '/workspace/repo',
              depth: 10,
              limit: 5000
            });
            fileList = (tree.entries as Array<{ path: string; type: string }>)
              .filter((entry) => entry.type === 'file')
              .map((entry) => entry.path.replace(/^\/workspace\/repo\//, ''));
          } catch {
            fileList = [];
          }
        }
        const selection = selectContext({
          goal,
          files: fileList,
          maxResults: 15
        });
        const packedFiles = selection.results.map((r) => ({
          path: r.path,
          reason: r.reason,
          confidence: r.confidence,
          adjacentTests: r.adjacentTests
        }));
        return {
          repository,
          goal,
          packed_files: packedFiles,
          token_budget: maxTokens,
          next_step: 'Context pack prepared. Read top confidence files using forge_files_read paths:[...] when ready to edit.'
        };
      },
      forge_task_list: async (input) => {
        const identity = this.identity();
        const store = new D1TaskStore(env.METADATA);
        const limit = number(input.limit);
        const q = input.q ? text(input.q) : undefined;
        const tasks = await store.list(identity.tenantId as TenantId, {
          state: input.state ? (text(input.state) as TaskState) : undefined,
          q,
          limit
        });
        // Tell the model when the limit clipped the result so it can narrow
        // rather than assume it saw everything.
        const hint = tasks.length === limit
          ? `Showing ${tasks.length} tasks (limit reached). Narrow with a state or q filter, or raise limit.`
          : undefined;
        return { tasks: tasks.map((task) => summarizeTask(task)), returned: tasks.length, ...(hint ? { hint } : {}) };
      },
      forge_task_finish: async (input) => {
        const identity = this.identity();
        const store = new D1TaskStore(env.METADATA);
        const task = await this.loadTask(text(input.task_id) as TaskId);
        assertTaskOwnership(task, { tenantId: identity.tenantId as TenantId });
        const outcome = text(input.outcome) as TaskState;
        // Enforce the task state machine up front so an illegal finish (e.g.
        // finishing an already-terminal task, or a transition the lifecycle does
        // not permit) fails with a clear ForgeError before any store write.
        // applyTaskPatch re-checks the same invariant as defense in depth.
        if (isTerminalTaskState(task.state)) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `Task is already in the terminal state "${task.state}" and cannot be finished again.`,
            retryable: false,
            details: { taskId: task.id, state: task.state, outcome }
          });
        }
        assertTaskTransition(task.state, outcome);
        const force = Boolean(input.force);
        if (outcome === 'complete') {
          const gaps = hasBlockingCompletionGaps(task);
          if (gaps.length > 0 && !force) {
            throw new ForgeError({
              code: 'FORGE_VALIDATION_FAILED',
              message: `Task cannot be marked complete: ${gaps.join(' ')} Pass force with a note explaining what is unverified to override.`,
              retryable: false,
              details: { taskId: task.id, gaps }
            });
          }
          if (gaps.length > 0 && force && !input.note) {
            throw new ForgeError({
              code: 'FORGE_VALIDATION_FAILED',
              message: `force requires a note explaining what remains unverified: ${gaps.join(' ')}`,
              retryable: false,
              details: { taskId: task.id, gaps }
            });
          }
        }
        const outstanding = input.note ? [...task.outstanding, text(input.note)] : task.outstanding;
        const updated = applyTaskPatch(
          task,
          { state: outcome, outstanding },
          new Date().toISOString(),
          optionalNumber(input.expected_revision)
        );
        await store.put(updated);
        await this.recordAudit(
          'task.finish',
          identity.tenantId,
          {
            taskId: updated.id,
            outcome: updated.state,
            forced: force,
            note: input.note ? text(input.note) : undefined,
            pushedAt: updated.pushedAt,
            changedFileCount: updated.changedFiles.length
          },
          { workspaceId: updated.workspaceId }
        );
        // A task can legitimately finish with work still queued for a human —
        // that is the point of a deferred submission. Report it so the agent
        // closes out by telling the human what is sitting in their queue,
        // instead of implying the pull request already exists.
        const queued = updated.workspaceId
          ? await listDeferredActionsForWorkspace(env, identity.tenantId, updated.workspaceId)
              .then((actions) => actions.filter((action) => action.state === 'awaiting_approval' || action.state === 'failed'))
              .catch(() => [])
          : [];
        return {
          task_id: updated.id,
          state: updated.state,
          revision: updated.revision,
          ...(queued.length > 0
            ? {
                awaiting_review: queued.map((action) => ({
                  deferred_action_id: action.id,
                  branch: action.branch,
                  base: action.base,
                  state: action.state,
                  files_changed: action.filesChanged,
                  approval_url: `${env.FORGE_PUBLIC_ORIGIN}/approvals/${action.approvalId}`
                })),
                next_step: `Work is staged and waiting for a human. Tell them ${queued.length === 1 ? 'it is' : 'they are'} ready to review at ${env.FORGE_PUBLIC_ORIGIN}/app — they can approve whenever, and Forge will push and open the draft pull request then.`
              }
            : {})
        };
      },
      forge_context_get: async (input) => {
        const identity = this.identity();
        const root = text(input.root);
        const tree = await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).filesTree({
          path: root,
          depth: 20,
          limit: 10000
        });
        const files = (tree.entries as Array<{ path: string; type: string }>)
          .filter((entry) => entry.type === 'file')
          .map((entry) => entry.path.replace(/^\/workspace\/repo\//, ''));
        return asRecord(selectContext({
          goal: text(input.goal),
          files,
          root: root.replace(/^\/workspace\/repo\/?/, ''),
          maxResults: number(input.max_results),
          categories: input.categories as ('source' | 'tests' | 'docs' | 'config')[] | undefined
        }));
      },
      forge_diff_metadata: async (input) => {
        const identity = this.identity();
        // Summary of the WHOLE change, so it stays a reliable overview of a
        // diff too large to read: the file list, line counts and path-derived
        // facts come from --numstat and cover every file. Only the content-
        // derived parts (changed symbols, possible secrets) need hunks, so
        // those are computed over as much of the diff as fits one generous
        // page, and `note` says when that fell short.
        const outgoing = await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).gitOutgoingDiff({
          base: text(input.base),
          maxBytes: 400_000
        });
        const compact = analyzeDiff(outgoing.diff);
        const analyzed = new Map(compact.files.map((file) => [file.path, file]));
        const files = outgoing.files.map((file) => {
          const seen = analyzed.get(file.path);
          return {
            path: file.path,
            changeType: seen?.changeType ?? (file.binary ? 'binary' : 'modified'),
            additions: file.additions,
            deletions: file.deletions,
            changedSymbols: seen?.changedSymbols ?? [],
            possibleSecret: seen?.possibleSecret ?? false,
            ...(seen?.facts === undefined ? {} : { facts: seen.facts })
          };
        });
        const unanalyzed = files.length - compact.files.length;
        return {
          ...compact,
          files,
          totalAdditions: outgoing.totalAdditions,
          totalDeletions: outgoing.totalDeletions,
          diffHash: outgoing.diffHash,
          base: outgoing.base,
          branch: outgoing.branch,
          suggestedChecks: suggestChecks(files.map((file) => file.path)),
          rawDiffAvailableVia: 'forge_git_outgoing_diff',
          note: unanalyzed > 0
            ? `This is a syntax-only summary. File list and line counts cover all ${files.length} changed files; symbol and secret detection covers the first ${compact.files.length} (${unanalyzed} too large to scan here — read them with forge_git_outgoing_diff paths:[...]). Inspect the raw diff before any Git mutation.`
            : 'This is a syntax-only summary. Inspect the raw diff before any Git mutation.'
        };
      },
      forge_review: async (input) => {
        const identity = this.identity();
        // SSRF guard: the caller-supplied URL is fetched by the browser provider,
        // so reject private, loopback, link-local and metadata hosts BEFORE any
        // capture is attempted. assertPublicHost throws a ForgeError for blocked
        // targets (127.x, 10.x, 192.168.x, 172.16-31.x, 169.254.x incl. the cloud
        // metadata IP, ::1, fc/fd/fe80, localhost, *.local).
        // URL.hostname wraps IPv6 literals in brackets ("[::1]"); strip them so
        // the policy's bare-address rules (::1, fc.., fd.., fe80:) still match.
        assertPublicHost(new URL(text(input.url)).hostname.replace(/^\[|\]$/g, ''));
        const workspaceId = ids.workspace();
        // Bind this url_review workspace to its owner so forge_artifact_get can
        // authorize by ownership, not R2 key shape (best-effort; see helper).
        await recordUrlReviewOwner(env, workspaceId, identity.tenantId, identity.projectId);
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        // Arbitrary-URL review always renders on Cloudflare, never the mini (SSRF guard).
        const browser = await selectBrowserProvider(env, artifacts, identity.tenantId as TenantId, false);
        const captures = input.captures as Array<{ selection?: string; path: string; state: string }>;
        const viewports = normalizeViewports(input.viewports);
        const evidence: Array<Record<string, unknown>> = [];
        const failures: Array<Record<string, unknown>> = [];
        const skipped: Array<Record<string, unknown>> = [];
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        // Each (capture × viewport) cell is captured independently so one slow
        // or failing route cannot discard evidence that already succeeded. Cells
        // run with bounded concurrency (Browser Run calls are seconds long) and
        // share a soft deadline so a slow route is skipped rather than lost — the
        // per-cell provider retry is deadline-aware so it stops in step.
        // Bounded by the caller's budget rather than a fixed 110s. A chat client
        // abandons a slow tool call and leaves the user with nothing at all, so
        // the default is short and we return whatever succeeded inside it;
        // callers that can genuinely wait raise time_budget_ms.
        const startedAt = Date.now();
        const deadlineAt = startedAt + number(input.time_budget_ms);
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
                  limitations: ['A static screenshot only proves what it shows — it does not prove that any unexecuted interaction works.']
                }
              };
            } catch (error) {
              return {
                kind: 'failure',
                value: { route: capture.path, environment: viewport.id, reason: error instanceof Error ? error.message.slice(0, 500) : 'The capture failed for an unknown reason.' }
              };
            }
          }
        );
        // Widget-only screenshot gallery: small JPEG data: URIs the console can
        // render inline. Reuses the same inline bytes the model receives via
        // MCP content, capped so the _meta payload stays bounded. This never
        // enters structuredContent (base64 stays out of what the model reads).
        const screenshots: Array<{ route: unknown; viewport: unknown; state: unknown; findingCount: number; dataUri: string }> = [];
        const captured: Array<{ route: unknown; viewport: unknown; state: unknown; findingCount: number; inline?: { base64: string; contentType: string } }> = [];
        for (const outcome of outcomes) {
          if (outcome.kind === 'evidence') {
            evidence.push(outcome.value);
            captured.push({
              route: outcome.value.route,
              viewport: outcome.value.observedViewport ?? outcome.value.requestedViewport,
              state: outcome.value.state,
              findingCount: findingCountOf(outcome.value),
              inline: outcome.inline
            });
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
        // The images are the deliverable — send back as many as fit, spread across
        // routes rather than clustered on whichever finished first.
        const { chosen: inlineCells, omitted: omittedImages } = await prepareInlineImages(env, captured);
        for (const cell of inlineCells) {
          content.push({ type: 'image', data: cell.inline!.base64, mimeType: cell.inline!.contentType });
        }
        if (evidence.length === 0) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'Could not capture any screenshots from the requested URL. Check that the URL is reachable and the routes exist, then retry.',
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
        // A link the model can simply hand over. Best-effort: the attached images
        // stay the primary path, so a failure to write the page must not fail the
        // review that produced them.
        const capturedAtIso = new Date().toISOString();
        const galleryUrl = await storeGallery(env, identity, workspaceId, text(input.url), capturedAtIso, captured);
        const packet = {
          schemaVersion: 1,
          provider: 'forge',
          executionMode: 'url_review',
          containerUsed: false,
          workspaceId,
          sourceUrl: text(input.url),
          capturedAt: capturedAtIso,
          requestedCaptures: cells.length,
          capturedCount: evidence.length,
          complete,
          evidence: evidenceCells,
          failures,
          skipped,
          structureSummary,
          limitations: ['A static screenshot only proves what it shows — it does not prove that any unexecuted interaction works.'],
          inlineImageCount: inlineCells.length,
          omittedImageCount: omittedImages,
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
          // Deliberately does not send the caller off to fetch artifacts one by
          // one. The images are already attached; a chat client that cannot
          // reliably chain a second call would otherwise be told its screenshots
          // are somewhere else, having just been handed them.
          galleryUrl,
          nextStep: [
            `Inspect the ${inlineCells.length} image(s) attached to this result — they are the evidence.`,
            omittedImages > 0
              ? `${omittedImages} further capture(s) did not fit in this response; fetch them with forge_artifact_get on evidence[].screenshot.artifactId, or re-run with fewer routes or one viewport.`
              : '',
            complete ? '' : 'Some cells failed or were skipped (see failures and skipped) — re-run just those routes; fewer routes per call captures more reliably.',
            galleryUrl ? `Give the human this link to see them all in a browser: ${galleryUrl}` : '',
            'Then pass the evidence to Parallax with inspected set to true.'
          ].filter(Boolean).join(' ')
        };
        const structureNote =
          structureSummary.totalFindings > 0
            ? ` Structure health flagged ${structureSummary.totalFindings} heading defect(s) across ${structureSummary.affectedCells} evidence cell(s) (see structureSummary) — resolve or explicitly accept these before passing the review.`
            : '';
        const attachedNote = omittedImages > 0
          ? ` ${inlineCells.length} are attached here; ${omittedImages} more are stored.`
          : ' All are attached to this message.';
        const galleryNote = galleryUrl ? ` View them all in a browser: ${galleryUrl}` : '';
        const summary = complete
          ? `Captured ${evidence.length} screenshot(s) of ${text(input.url)} without starting a container.${attachedNote}${galleryNote}${structureNote}`
          : `Captured ${evidence.length} of ${cells.length} screenshot(s) of ${text(input.url)} without starting a container (${failures.length} failed, ${skipped.length} skipped).${attachedNote} Re-run the remaining routes in smaller batches.${galleryNote}${structureNote}`;
        content.unshift({ type: 'text', text: summary });
        return forgeToolResponse(packet, content);
      },
      forge_workspace_create: async (input) => {
        const identity = this.identity();
        const credentialProfileId = await this.selectedCredentialProfileId(identity);
        const repository = input.repository as { provider: 'github'; owner: string; name: string };
        await authorizeRepository(env, identity, repository);
        const idempotencyKey = idempotency(input.idempotency_key);
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
            ...(credentialProfileId ? { credentialProfileId: credentialProfileId as CredentialProfileId } : {}),
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
        // Wait here rather than making the caller poll. Provisioning takes about
        // a minute, and "call forge_workspace_get repeatedly until state is
        // ready" is a loop an ordinary chat session cannot be relied on to run —
        // it needs a human nudging it through each turn, and any turn that drops
        // the workspace_id strands a container nobody destroys. One call that
        // comes back usable is the difference between this flow working and not.
        // Bounded: if the budget runs out the caller still gets the id and the
        // real state, and polling remains available for anyone who wants it.
        let state = result.state;
        if (Boolean(input.wait_for_ready) && !['ready', 'failed', 'destroyed'].includes(state)) {
          const waitUntil = Date.now() + number(input.wait_budget_ms);
          while (Date.now() < waitUntil) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const current = await coordinator(env, workspaceId).getState().catch(() => undefined);
            if (!current) continue;
            state = current.state;
            if (['ready', 'failed', 'destroyed'].includes(state)) break;
          }
        }
        return {
          workspace_id: workspaceId,
          state,
          operation_id: result.operationId,
          workspace_revision: result.revision,
          ...(credentialProfileId ? { credential_profile_id: credentialProfileId } : {}),
          next_step: state === 'ready'
            ? 'The workspace is ready — use this workspace_id for the rest of the task, and destroy it when done.'
            : state === 'failed'
              ? 'Provisioning failed. Read forge_workspace_get for the reason; do not keep polling.'
              : `Still provisioning after the wait budget. Call forge_workspace_get with this workspace_id to check again — it is usually ready within a minute of creation.`
        };
      },
      forge_workspace_get: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).getState());
      },
      forge_files_tree: async (input) => {
        const identity = this.identity();
        const tree = await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).filesTree({
          path: text(input.path),
          depth: number(input.depth),
          limit: number(input.limit)
        });
        // Tell the model the listing was clipped so it narrows (deeper path,
        // higher limit) instead of assuming it saw the whole tree.
        const hint = (tree as { truncated?: boolean }).truncated
          ? 'Listing truncated at the limit. Narrow with a deeper path or raise limit.'
          : undefined;
        return asRecord({ ...tree, ...(hint ? { hint } : {}) });
      },
      forge_files_read: async (input) => {
        const identity = this.identity();
        const paths = Array.isArray(input.paths) && input.paths.length > 0
          ? (input.paths as unknown[]).map((value) => text(value))
          : input.path !== undefined
            ? [text(input.path)]
            : [];
        if (paths.length === 0) {
          throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: 'Provide either path or a non-empty paths array.', retryable: false });
        }
        // Aggregate-work ceiling: the per-file max_bytes (up to 500KB) applied
        // across up to 20 paths would let a single call pull ~10MB into the
        // Worker. Cap the total requested bytes so the batch cannot be used to
        // amplify memory/CPU, independent of the per-file bound.
        const MAX_TOTAL_READ_BYTES = 2_000_000;
        const perFileMaxBytes = number(input.max_bytes);
        if (paths.length * perFileMaxBytes > MAX_TOTAL_READ_BYTES) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `This read exceeds the ${MAX_TOTAL_READ_BYTES}-byte aggregate limit (${paths.length} paths x ${perFileMaxBytes} bytes each). Reduce max_bytes or read fewer paths per call.`,
            retryable: false,
            details: { paths: paths.length, maxBytes: perFileMaxBytes, totalLimit: MAX_TOTAL_READ_BYTES }
          });
        }
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id));
        const readOne = {
          startLine: optionalNumber(input.start_line),
          endLine: optionalNumber(input.end_line),
          maxBytes: perFileMaxBytes
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
              // Surface a real ForgeErrorCode so an agent keying on codes never
              // meets an undocumented one.
              return { path, error: toForgeError(error).code, message: error instanceof Error ? error.message.slice(0, 300) : 'The read failed for an unknown reason.' };
            }
          })
        );
        return { files };
      },
      forge_files_write: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).filesWrite({
          path: text(input.path),
          content: text(input.content),
          expectedSha256: input.expected_sha256 ? text(input.expected_sha256) : undefined,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: idempotency(input.idempotency_key)
        }));
      },
      forge_files_patch: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).filesPatch({
          patch: text(input.patch),
          idempotencyKey: idempotency(input.idempotency_key)
        }));
      },
      forge_shell_exec: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const command = text(input.command);
        const cwd = text(input.cwd);
        const networkPolicy = text(input.network_policy) as never;
        const workspace = await authorizedCoordinator(env, identity, workspaceId);
        const decision = classifyCommand(command, networkPolicy);
        let approvalId = input.approval_id ? text(input.approval_id) : undefined;
        const userEnv = input.environment as Record<string, string>;
        const attached = await vaultService(env).attachedEnv(identity.tenantId as TenantId, workspaceId);
        const environment = { ...attached.vars, ...userEnv };
        const environmentHash = await sha256(JSON.stringify(Object.entries(userEnv).sort(([left], [right]) => left.localeCompare(right))));
        const approvalPayload = { command, cwd, networkPolicy, environmentHash };
        let claimedApproval = false;
        if (decision.allowed && decision.approvalRequired) {
          if (mayAutoApproveShell(env, decision.classification, networkPolicy)) {
            claimedApproval = true;
          } else if (!approvalId) {
            const approval = await requestApproval(env, identity, workspaceId, 'shell.exec', `Run ${decision.classification} command`, approvalPayload);
            if (approval.already_approved) {
              approvalId = approval.approval_id;
              await requireApproval(env, identity, approvalId, workspaceId, 'shell.exec', approvalPayload);
              claimedApproval = true;
            } else {
              const inline = await this.tryResolveApprovalInline(identity, approval, `Run ${decision.classification} command`);
              if (!inline) {
                throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: 'This command needs human approval. Open the approval URL, approve this exact command, then retry the call with approval_id.', retryable: false, details: { kind: 'approval', action: 'shell.exec', ...approval } });
              }
              approvalId = inline;
              await requireApproval(env, identity, approvalId, workspaceId, 'shell.exec', approvalPayload);
              claimedApproval = true;
            }
          } else {
            await requireApproval(env, identity, approvalId, workspaceId, 'shell.exec', approvalPayload);
            claimedApproval = true;
          }
        }
        try {
          if (input.async === true) {
            const proc = await workspace.processStart({
              command,
              cwd: cwd.replace(/\/+$/u, '') || cwd,
              environment,
              networkPolicy,
              expectedRevision: optionalNumber(input.expected_revision),
              idempotencyKey: idempotency(input.idempotency_key),
              approved: claimedApproval
            });
            if (claimedApproval && approvalId) await completeApproval(env, approvalId, true, { reusable: true });
            const procRecord = proc as unknown as Record<string, unknown>;
            const value = (procRecord.value && typeof procRecord.value === 'object'
              ? procRecord.value
              : procRecord) as Record<string, unknown>;
            const processId = value.id ?? procRecord.processId ?? procRecord.id;
            if (typeof processId !== 'string' || !processId.startsWith('proc_')) {
              throw new ForgeError({
                code: 'FORGE_WORKSPACE_CONFLICT',
                message: 'Managed process start did not return a process id; inspect forge_workspace_get before retrying with a new idempotency key.',
                retryable: false,
                details: { replay: Boolean(procRecord.replay) }
              });
            }
            const status = String(value.status ?? procRecord.status ?? 'running');
            return {
              processId,
              status,
              command,
              async: true,
              replay: Boolean(procRecord.replay),
              next_step: `Call forge_process_wait with process_id ${processId} (use timeout_ms >= 600000 for dependency installs), or forge_process_logs to inspect output.`
            };
          }
          const result = await workspace.shellExec({
            command,
            cwd,
            timeoutMs: number(input.timeout_ms),
            environment,
            networkPolicy,
            outputLimitBytes: number(input.output_limit_bytes),
            expectedRevision: optionalNumber(input.expected_revision),
            idempotencyKey: idempotency(input.idempotency_key),
            approved: claimedApproval
          });
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, true, { reusable: true });
          const stdout = 'stdout' in result ? String(result.stdout ?? '') : '';
          const stderr = 'stderr' in result ? String(result.stderr ?? '') : '';
          return {
            ...asRecord(result),
            stdout: attached.redact.size > 0 ? await vaultService(env).redactOutput(stdout, identity.tenantId as TenantId, workspaceId) : stdout,
            stderr: attached.redact.size > 0 ? await vaultService(env).redactOutput(stderr, identity.tenantId as TenantId, workspaceId) : stderr
          };
        } catch (error) {
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_process_start: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const attached = await vaultService(env).attachedEnv(identity.tenantId as TenantId, workspaceId);
        const environment = { ...attached.vars, ...(input.environment as Record<string, string>) };
        return asRecord(await (await authorizedCoordinator(env, identity, workspaceId)).processStart({
          command: text(input.command),
          cwd: text(input.cwd),
          environment,
          networkPolicy: text(input.network_policy) as never,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: idempotency(input.idempotency_key)
        }));
      },
      forge_process_logs: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).processLogs({
          processId: text(input.process_id) as ProcessId,
          cursor: input.cursor ? text(input.cursor) : undefined
        }));
      },
      forge_process_get: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).processGet({
          processId: text(input.process_id) as ProcessId
        }));
      },
      forge_process_stop: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).processStop({
          processId: text(input.process_id) as ProcessId,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_process_wait: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).processWait({
          processId: text(input.process_id) as ProcessId,
          timeoutMs: optionalNumber(input.timeout_ms) ?? 120_000
        }));
      },
      forge_process_cancel: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).processCancel({
          processId: text(input.process_id) as ProcessId,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_check_start: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const attached = await vaultService(env).attachedEnv(identity.tenantId as TenantId, workspaceId);
        const environment = { ...attached.vars, ...(input.environment as Record<string, string>) };
        return asRecord(await (await authorizedCoordinator(env, identity, workspaceId)).checkStart({
          name: text(input.name), command: text(input.command), cwd: text(input.cwd),
          environment, networkPolicy: text(input.network_policy) as never,
          expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_check_get: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).checkGet({
          processId: text(input.process_id) as ProcessId
        }));
      },
      forge_check_cancel: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, text(input.workspace_id))).processStop({
          processId: text(input.process_id) as ProcessId,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: text(input.idempotency_key)
        }));
      },
      forge_dependencies_install: async (input) => {
        const identity = this.identity();
        const workspaceId = text(input.workspace_id);
        const attached = await vaultService(env).attachedEnv(identity.tenantId as TenantId, workspaceId);
        const environment = { ...attached.vars };
        const coordinator = await authorizedCoordinator(env, identity, workspaceId);
        const result = await coordinator.dependenciesInstall({
          frozenLockfile: Boolean(input.frozen_lockfile),
          allowLockfileUpdate: Boolean(input.allow_lockfile_update),
          networkPolicy: text(input.network_policy) as never,
          timeoutMs: optionalNumber(input.timeout_ms) ?? 600_000,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: idempotency(input.idempotency_key)
        });
        return asRecord(result);
      },
      forge_git_status: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).gitStatus());
      },
      forge_git_diff: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).gitDiff({
          staged: Boolean(input.staged),
          ...diffPaging(input)
        }));
      },
      forge_git_branch_create: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).gitBranchCreate({
          branch: text(input.branch), expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: idempotency(input.idempotency_key)
        }));
      },
      forge_git_commit: async (input) => {
        const identity = this.identity();
        const coordinator = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id));
        let message = input.message === undefined ? '' : text(input.message);
        // Blank message + AI on: synthesise a commit message from the working
        // diff. Best-effort — generateCommitMessage never throws, and if the
        // diff is empty we leave the message blank so gitCommit enforces the
        // existing required-message contract.
        if (!message.trim() && aiEnabled(env)) {
          const diff = await coordinator.gitDiff({ staged: false, maxBytes: 32_000 }).then((r) => r.diff).catch(() => '');
          if (diff.trim()) message = await generateCommitMessage(env, diff);
        }
        return asRecord(await coordinator.gitCommit({
          message, paths: input.paths as string[], expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: idempotency(input.idempotency_key)
        }));
      },
      forge_git_outgoing_diff: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).gitOutgoingDiff({
          base: text(input.base),
          ...diffPaging(input)
        }));
      },
      forge_git_push: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const branch = text(input.branch);
        const base = text(input.base);
        const diffHash = text(input.expected_diff_hash);
        let approvalId = input.approval_id ? text(input.approval_id) : undefined;
        const markTaskPushed = async () => {
          // Best-effort: record the push against whichever task owns this
          // workspace, so forge_task_finish can tell a pushed branch apart
          // from committed-but-stranded work. Never blocks the push itself.
          const store = new D1TaskStore(env.METADATA);
          await store.getByWorkspace(workspaceId).then(async (task) => {
            if (!task) return;
            await store.put({ ...task, pushedAt: new Date().toISOString() });
          }).catch(() => undefined);
        };
        const executePush = async () => {
          const coordinator = await authorizedCoordinator(env, identity, workspaceId);
          return coordinator.gitPush({
            branch, base, expectedDiffHash: diffHash, expectedRevision: optionalNumber(input.expected_revision), idempotencyKey: idempotency(input.idempotency_key)
          });
        };

        // Envelope fast path: a prior forge_task_authorize_push_envelope for
        // this exact (workspace, branch, base) lets this push skip the human
        // click entirely — but only while it still satisfies the envelope's
        // invariant, re-checked fresh on every call: the branch fast-forwards
        // from the last envelope-covered commit (no rewritten history), and
        // every changed path is covered by allowed_paths. Anything that fails
        // either check falls straight through to the normal per-push approval
        // below — the envelope never widens itself.
        if (!approvalId) {
          const envelope = await findActiveEnvelope(env, identity.tenantId, workspaceId, branch, base);
          if (envelope) {
            const coordinator = await authorizedCoordinator(env, identity, workspaceId);
            // Hash over the whole change, and the path list straight from
            // `git diff --name-only` — never from the returned hunks, which
            // are one page of files and would let anything after the page cut
            // slip past allowed_paths unchecked. gitOutgoingPaths fails closed
            // if it cannot enumerate every path.
            const outgoing = await coordinator.gitOutgoingDiff({ base, maxBytes: 2_000 }).catch(() => undefined);
            const changedPaths = outgoing ? await coordinator.gitOutgoingPaths({ base }).catch(() => undefined) : undefined;
            const hashOk = outgoing?.diffHash === diffHash;
            const pathsOk = hashOk && changedPaths !== undefined && pathsWithinEnvelope(changedPaths, envelope.allowedPaths);
            const ffOk = pathsOk && (envelope.lastApprovedCommit
              ? await coordinator.gitIsAncestor({ ancestor: envelope.lastApprovedCommit })
              : true);
            if (hashOk && pathsOk && ffOk) {
              const result = await executePush();
              await markTaskPushed();
              const newCommit = (result as { commit?: string }).commit;
              if (newCommit) await recordEnvelopePush(env, envelope.id, newCommit);
              await this.recordAudit(
                'git.push',
                identity.tenantId,
                { branch, base, diffHash, via: 'envelope', envelopeId: envelope.id },
                { workspaceId }
              );
              return asRecord(result);
            }
          }
        }

        if (!approvalId) {
          // Attach the actual outgoing diff so the human approves what they can
          // see, not an opaque hash. Best-effort — `diff` is display-only; the
          // diffHash remains the integrity check enforced by requireApproval.
          const outgoing = await (await authorizedCoordinator(env, identity, workspaceId))
            .gitOutgoingDiff({ base, maxBytes: 200_000 }).catch(() => undefined);
          const approval = await requestApproval(env, identity, workspaceId, 'git.push', `Push ${branch} to GitHub`, { branch, base, diffHash, diff: outgoing?.diff ?? '', diffTotals: diffTotals(outgoing) });
          const inline = await this.tryResolveApprovalInline(identity, approval, `Push ${branch} to GitHub`);
          if (!inline) {
            throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: approval.already_approved ? 'This exact push was already approved. No need to open the URL again — retry the call with approval_id.' : 'This push needs human approval. Open the approval URL, approve this exact push, then retry the call with approval_id. To avoid a human click on every future push in this task, ask them to run forge_task_authorize_push_envelope once instead.', retryable: false, details: { kind: 'approval', action: 'git.push', ...approval } });
          }
          approvalId = inline;
        }
        await requireApproval(env, identity, approvalId, workspaceId, 'git.push', { branch, base, diffHash });
        try {
          const result = await executePush();
          await completeApproval(env, approvalId, true);
          await markTaskPushed();
          await this.recordAudit(
            'git.push',
            identity.tenantId,
            { branch, base, diffHash },
            { workspaceId }
          );
          return asRecord(result);
        } catch (error) {
          await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_task_authorize_push_envelope: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const branch = text(input.branch);
        const base = text(input.base);
        const taskId = input.task_id ? text(input.task_id) : undefined;
        const ttlMinutes = number(input.ttl_minutes);
        let approvalId = input.approval_id ? text(input.approval_id) : undefined;
        const coordinator = await authorizedCoordinator(env, identity, workspaceId);
        // The envelope's default allow-list must cover every currently changed
        // path, so it comes from the complete `--name-only` list rather than
        // from a page of hunks — an under-wide default would quietly block
        // later pushes, and is derived from the same source the push-time
        // check uses.
        const defaultPaths = [...new Set(await coordinator.gitOutgoingPaths({ base }).catch(() => []))];
        const allowedPaths = (input.allowed_paths as string[] | undefined) ?? defaultPaths;
        // Display-only, for the approval page: a bounded page of the diff plus
        // the true totals, so the reviewer sees real scale even when the change
        // is too large to render whole.
        const envelopePreview = await coordinator.gitOutgoingDiff({ base, maxBytes: 200_000 }).catch(() => undefined);
        if (allowedPaths.length === 0) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'No allowed_paths given and the current outgoing diff is empty — there is nothing to scope the envelope to. Make a change first, or pass allowed_paths explicitly.',
            retryable: false
          });
        }
        if (!approvalId) {
          const approval = await requestApproval(
            env, identity, workspaceId, 'task.push_envelope', `Pre-authorize pushes to ${branch}`,
            { branch, base, allowedPaths, ttlMinutes, diff: envelopePreview?.diff ?? '', diffTotals: diffTotals(envelopePreview) }
          );
          const reason = `Pre-authorize pushes to ${branch} touching only ${allowedPaths.join(', ')}`;
          const inline = await this.tryResolveApprovalInline(identity, approval, reason);
          if (!inline) {
            throw new ForgeError({
              code: 'FORGE_APPROVAL_REQUIRED',
              message: approval.already_approved
                ? 'This exact envelope was already approved. No need to open the URL again — retry the call with approval_id.'
                : `This authorizes Forge to auto-approve future pushes to ${branch} for the next ${ttlMinutes} minutes, as long as each one only touches ${allowedPaths.join(', ')} and fast-forwards with no rewritten history — every other push (and every pull request) still needs its own approval. Open the approval URL, approve it, then retry the call with approval_id.`,
              retryable: false,
              details: { kind: 'approval', action: 'task.push_envelope', ...approval }
            });
          }
          approvalId = inline;
        }
        // Only compare primitives here — allowedPaths is an array and the
        // generic equality check in requireApproval is a strict !==, which
        // would never match a freshly-parsed array even when the content is
        // identical. The approval page already showed the human the paths.
        await requireApproval(env, identity, approvalId, workspaceId, 'task.push_envelope', { branch, base });
        try {
          const state = await coordinator.getState();
          const envelope = await createPushEnvelope(env, {
            tenantId: identity.tenantId,
            workspaceId,
            taskId,
            branch,
            base,
            allowedPaths,
            startCommit: (state as { currentCommit?: string }).currentCommit ?? null,
            ttlMinutes
          });
          await completeApproval(env, approvalId, true);
          await this.recordAudit(
            'task.push_envelope.authorize',
            identity.tenantId,
            { branch, base, allowedPaths, ttlMinutes, envelopeId: envelope.id, taskId },
            { workspaceId }
          );
          return {
            envelope_id: envelope.id,
            branch: envelope.branch,
            base: envelope.base,
            allowed_paths: envelope.allowedPaths,
            expires_at: envelope.expiresAt,
            next_step: 'Future forge_git_push calls to this branch will auto-satisfy while they stay inside this envelope. Pushes outside it (new paths, rewritten history, a different branch) still need a normal approval.'
          };
        } catch (error) {
          await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      // Finish-and-walk-away. Everything a submission needs is captured here and
      // parked on a Forge-owned ref, so the agent never waits on a human and the
      // workspace is free to die immediately afterwards. See deferred-actions.ts.
      forge_submit_for_review: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const branch = text(input.branch);
        const base = text(input.base);
        const taskIdInput = input.task_id ? text(input.task_id) : null;
        let title = input.title === undefined ? '' : text(input.title);
        let body = input.body === undefined ? '' : text(input.body);

        const coordinator = await authorizedCoordinator(env, identity, workspaceId);
        const state = await coordinator.getState();

        // Commit anything still in the working tree FIRST. Staging pushes HEAD,
        // and the outgoing diff is computed against commits, so uncommitted edits
        // would be silently absent from both — the human would be shown, and
        // would approve, a pull request containing none of the actual work. This
        // is also what makes "submit" a genuine single call rather than a
        // commit-then-submit dance the agent has to remember.
        const status = await coordinator.gitStatus().catch(() => undefined);
        let autoCommitted = false;
        if (status && !status.clean) {
          let message = '';
          if (aiEnabled(env)) {
            const working = await coordinator.gitDiff({ staged: false, maxBytes: 32_000 }).then((r) => r.diff).catch(() => '');
            if (working.trim()) message = await generateCommitMessage(env, working).catch(() => '');
          }
          await coordinator.gitCommit({
            message: message.trim() || `chore: submit ${branch.replace(/^forge\//, '')} for review`,
            paths: [],
            idempotencyKey: `submit-autocommit-${workspaceId}-${branch}`
          });
          autoCommitted = true;
        }

        // A bounded first page: enough diff for the summariser to work from,
        // while `totalFiles` still counts the whole change. Counting
        // `diff --git` lines here would only ever see this page and could call
        // a large submission empty.
        const outgoing = await coordinator.gitOutgoingDiff({ base, maxBytes: 48_000 }).catch(() => undefined);
        const diff = outgoing?.diff ?? '';
        const filesChanged = outgoing?.totalFiles ?? 0;
        // Nothing to review is a mistake worth naming, not an empty pull request
        // for someone to puzzle over later.
        if (filesChanged === 0) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `There is nothing to submit: ${branch} has no changes against ${base}. Make the change first, then submit.`,
            retryable: false
          });
        }

        // Give the reviewer something readable to decide on. Best-effort: a
        // missing summariser must never be what stops work being submitted.
        if (!title.trim() && aiEnabled(env) && diff.trim()) {
          const summary = await summarizeDiffForPr(env, diff, { branch, base }).catch(() => undefined);
          if (summary) {
            title = summary.title;
            if (!body.trim()) body = summary.body;
          }
        }
        if (!title.trim()) title = `Forge: ${branch}`;

        // Park the commits somewhere durable BEFORE promising the human anything.
        // If staging fails there is nothing to approve, and the agent should hear
        // about it now rather than the reviewer discovering it days later.
        const stagedRef = `forge/staged/${workspaceId}/${branch.replace(/^forge\//, '')}`;
        const staged = await coordinator.stageForReview({ ref: stagedRef });

        const approval = await requestApproval(
          env,
          identity,
          workspaceId,
          'work.submit',
          `Merge ${branch} into ${base}`,
          { branch, base, title, body, commit: staged.commit, diff }
        );
        const action = await createDeferredAction(env, {
          tenantId: identity.tenantId,
          projectId: identity.projectId,
          workspaceId,
          approvalId: approval.approval_id,
          taskId: taskIdInput,
          action: 'work.submit',
          repository: { provider: 'github', owner: state.repository.owner, name: state.repository.name },
          // Pin the immutable id too: this submission may not be approved for
          // days, and a GitHub rename in the meantime would leave the slug alone
          // pointing at nothing.
          githubRepositoryId: await env.METADATA.prepare(
            "SELECT github_repository_id AS id FROM repositories WHERE tenant_id=?1 AND provider='github' AND owner=?2 AND name=?3 LIMIT 1"
          ).bind(identity.tenantId, state.repository.owner, state.repository.name)
            .first<{ id: string | null }>().then((row) => row?.id ?? null).catch(() => null),
          branch,
          base,
          stagedRef: staged.ref,
          commitSha: staged.commit,
          title,
          body,
          summary: `${filesChanged} file${filesChanged === 1 ? '' : 's'} changed`,
          filesChanged
        });

        await this.recordAudit(
          'work.submit',
          identity.tenantId,
          { branch, base, stagedRef: staged.ref, commit: staged.commit, approvalId: approval.approval_id },
          { workspaceId }
        );
        // Mark the task pushed: the work is durable off-box now, which is the
        // thing forge_task_finish actually cares about.
        await new D1TaskStore(env.METADATA).getByWorkspace(workspaceId).then(async (task) => {
          if (!task) return;
          await new D1TaskStore(env.METADATA).put({ ...task, pushedAt: new Date().toISOString() });
        }).catch(() => undefined);

        return {
          submitted: true,
          status: action.state,
          deferred_action_id: action.id,
          approval_id: approval.approval_id,
          approval_url: approval.approval_url,
          staged_ref: staged.ref,
          commit: staged.commit,
          branch,
          base,
          files_changed: filesChanged,
          auto_committed: autoCommitted,
          next_step: `Work is staged and queued for review. Tell the human it is done and waiting for them at ${approval.approval_url} (or in the Forge portal at ${env.FORGE_PUBLIC_ORIGIN}/app) — they can approve whenever they like, and Forge will push ${branch} and open the draft pull request then. Do not wait for them. This workspace can be destroyed now.`
        };
      },
      forge_pull_request_create: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const head = text(input.head);
        const base = text(input.base);
        const workspace = await authorizedCoordinator(env, identity, workspaceId);
        const initialState = await workspace.getState();
        if (base !== initialState.requestedRef) {
          throw new ForgeError({ code: 'FORGE_GIT_PUSH_BLOCKED', message: 'Draft PR target must match the immutable base ref recorded when this workspace was created.', retryable: false, details: { requestedBase: initialState.requestedRef, providedBase: base, baseCommit: initialState.baseCommit ?? null } });
        }
        let title = input.title === undefined ? '' : text(input.title);
        let body = input.body === undefined ? '' : text(input.body);
        let approvalId = input.approval_id ? text(input.approval_id) : undefined;
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
          const approval = await requestApproval(env, identity, workspaceId, 'pull_request.create', `Create draft pull request ${head} → ${base}`, { head, base, title, body, diff: outgoing?.diff ?? '', diffTotals: diffTotals(outgoing) });
          const inline = await this.tryResolveApprovalInline(identity, approval, `Create draft pull request ${head} → ${base}`);
          if (!inline) {
            throw new ForgeError({ code: 'FORGE_APPROVAL_REQUIRED', message: approval.already_approved ? 'This exact draft PR was already approved. No need to open the URL again — retry the call with approval_id.' : 'This draft PR needs human approval. Open the approval URL, approve it, then retry the call with approval_id.', retryable: false, details: { kind: 'approval', action: 'pull_request.create', ...approval } });
          }
          approvalId = inline;
        }
        await requireApproval(env, identity, approvalId, workspaceId, 'pull_request.create', { head, base, title, body });
        try {
          const state = await workspace.getState();
          const result = await createDraftPullRequest(env, identity, state.repository, { head, base, title, body });
          await completeApproval(env, approvalId, true);
          await this.recordAudit(
            'pull_request.create',
            identity.tenantId,
            { head, base, title, url: result.url },
            { workspaceId }
          );
          // Expose the PR link under a clearly-named field for the widget.
          return { ...result, pr_url: result.url };
        } catch (error) {
          await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_preview_expose: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id) as WorkspaceId;
        const value = await (await authorizedCoordinator(env, identity, workspaceId)).previewExpose({
          processId: text(input.process_id) as ProcessId,
          port: number(input.port),
          hostname: env.FORGE_PREVIEW_HOSTNAME,
          access: text(input.access) as never,
          ttlSeconds: number(input.ttl_seconds),
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: idempotency(input.idempotency_key)
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
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id) as WorkspaceId;
        // Getting here used to cost four calls and a polling loop: start the dev
        // server, poll its logs until it booted, expose a preview, then capture.
        // That is the whole "how does my app look right now" loop, and it is the
        // shape a chat session is worst at. With no preview_id, Forge does it —
        // detect the dev command, start it, wait for it to answer, expose it —
        // so screenshotting your own app is one call, same as a live URL.
        const workspace = await authorizedCoordinator(env, identity, workspaceId);
        let previewId = input.preview_id ? text(input.preview_id) : '';
        if (!previewId) {
          const deadline = Date.now() + number(input.preview_wait_ms);
          let lastReason = 'the dev server did not start in time';
          for (;;) {
            const started = await workspace.startReviewPreview({
              hostname: env.FORGE_PREVIEW_HOSTNAME,
              ttlSeconds: 3600
            }).catch((error: unknown) => ({
              ready: false as const,
              reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown'
            }));
            if (started.ready) {
              previewId = started.previewId;
              break;
            }
            lastReason = started.reason;
            // No dev server to run is terminal — waiting cannot conjure one.
            if (lastReason.includes('no dev server command') || Date.now() >= deadline) {
              throw new ForgeError({
                code: 'FORGE_PREVIEW_UNAVAILABLE',
                message: lastReason.includes('no dev server command')
                  ? 'No dev server command was detected for this project, so there is nothing to screenshot. Start it yourself with forge_process_start, expose it with forge_preview_expose, and pass the preview_id.'
                  : `The preview was not ready in time (${lastReason}). Check forge_process_logs, or raise preview_wait_ms.`,
                retryable: true
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
        const detail = await workspace.getPreviewInternal(previewId);
        if (new Date(detail.preview.expiresAt).getTime() <= Date.now()) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'This preview has expired. Call forge_review_capture again without a preview_id and Forge will bring a fresh one up.',
            retryable: true
          });
        }
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        const browser = await selectBrowserProvider(env, artifacts, detail.workspace.tenantId);
        const captures = input.captures as Array<{ selection?: string; route: string; state: string; steps?: Array<{ kind: BrowserActionStep['kind']; selector?: string; value?: string; key?: string; text?: string; path?: string; timeout_ms?: number }> }>;
        const viewports = normalizeViewports(input.viewports);
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
              const { inline, ...screenshotRef } = result.screenshot;
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
                limitations: [],
                // Carried only so the handler can build the widget gallery; it
                // is stripped from both structuredContent and _meta evidence.
                _inline: inline
              };
            } catch (error) {
              return { failure: { route: capture.route, environment: viewport.id, reason: error instanceof Error ? error.message.slice(0, 500) : 'The capture failed for an unknown reason.' } };
            }
          }
        );
        const evidence = captured.filter((cell): cell is Record<string, unknown> => !('failure' in cell));
        const failures = captured.filter((cell): cell is { failure: Record<string, unknown> } => 'failure' in cell).map((cell) => cell.failure);
        if (evidence.length === 0) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'Could not capture any screenshots from the preview. Confirm the preview is still running, then retry.',
            retryable: true,
            details: { failures }
          });
        }
        const structureSummary = summarizeStructure(
          evidence as Array<{ accessibility?: { structure?: { findingCount?: number; countsByKind?: Record<string, number>; truncated?: boolean } }; route?: unknown; environment?: unknown }>
        );
        // Widget-only screenshot gallery (small JPEG data: URIs) built from the
        // inline bytes captured above, capped so _meta stays bounded.
        const screenshots: Array<{ route: unknown; viewport: unknown; state: unknown; findingCount: number; dataUri: string }> = [];
        const capturedCells: Array<{ route: unknown; viewport: unknown; state: unknown; findingCount: number; inline?: { base64: string; contentType: string } }> = [];
        for (const cell of evidence) {
          const inline = cell._inline as { base64: string; contentType: string } | undefined;
          capturedCells.push({
            route: cell.route,
            viewport: cell.observedViewport ?? cell.requestedViewport,
            state: cell.state,
            findingCount: findingCountOf(cell),
            inline
          });
          if (inline && screenshots.length < MAX_GALLERY_IMAGES) {
            screenshots.push({
              route: cell.route,
              viewport: cell.observedViewport ?? cell.requestedViewport,
              state: cell.state,
              findingCount: findingCountOf(cell),
              dataUri: `data:${inline.contentType};base64,${inline.base64}`
            });
          }
        }
        // This tool used to attach nothing at all: it stored every screenshot and
        // told the caller to fetch them back one at a time. For the flow this
        // exists to serve — looking at your own app while designing it — that
        // meant the model never saw a single image without a second call per
        // shot. Attach them, and hand over a page for the rest, same as the
        // live-URL path.
        const capturedAtIso = new Date().toISOString();
        const { chosen: inlineCells, omitted: omittedImages } = await prepareInlineImages(env, capturedCells);
        const captureContent: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        for (const cell of inlineCells) {
          captureContent.push({ type: 'image', data: cell.inline!.base64, mimeType: cell.inline!.contentType });
        }
        const captureGalleryUrl = await storeGallery(
          env, identity, workspaceId, `preview of ${workspaceId}`, capturedAtIso, capturedCells
        );
        // Strip the transient inline bytes out of the full evidence so no base64
        // leaks into structuredContent or the _meta evidence array.
        const fullEvidence = evidence.map(({ _inline: _drop, ...rest }) => rest);
        // Concise per-cell rows for structuredContent — no base64, no heavy
        // accessibility trees; the component reads the rest from _meta.
        const evidenceCells = fullEvidence.map((cell) => ({
          selection: cell.selection,
          route: cell.route,
          environment: cell.environment,
          state: cell.state,
          requestedViewport: cell.requestedViewport,
          observedViewport: cell.observedViewport,
          findingCount: findingCountOf(cell),
          executedSteps: cell.executedSteps,
          inspected: cell.inspected
        }));
        const capturePacket = {
          schemaVersion: 1,
          provider: 'forge',
          executionMode: 'preview_review',
          workspaceId,
          repository: `${detail.workspace.repository.owner}/${detail.workspace.repository.name}`,
          commit: detail.workspace.currentCommit,
          workspaceRevision: detail.workspace.revision,
          capturedAt: new Date().toISOString(),
          previewId,
          requestedCaptures: cells.length,
          capturedCount: fullEvidence.length,
          evidence: evidenceCells,
          failures,
          structureSummary,
          limitations: [],
          _meta: {
            'forge/widget': {
              schemaVersion: 1,
              executionMode: 'preview_review',
              screenshots,
              evidence: fullEvidence,
              failures,
              structureSummary
            }
          },
          galleryUrl: captureGalleryUrl,
          inlineImageCount: inlineCells.length,
          omittedImageCount: omittedImages,
          nextStep: [
            `Inspect the ${inlineCells.length} image(s) attached to this result — they are the evidence.`,
            omittedImages > 0 ? `${omittedImages} further capture(s) did not fit; fetch them with forge_artifact_get on evidence[].screenshot.artifactId.` : '',
            captureGalleryUrl ? `Give the human this link to see them all in a browser: ${captureGalleryUrl}` : '',
            'Then mark that evidence inspected in Parallax, resolving or explicitly accepting any structureSummary heading defects.'
          ].filter(Boolean).join(' ')
        };
        captureContent.unshift({
          type: 'text',
          text: `Captured ${evidence.length} screenshot(s) of the running app.${
            omittedImages > 0
              ? ` ${inlineCells.length} are attached here; ${omittedImages} more are stored.`
              : ' All are attached to this message.'
          }${captureGalleryUrl ? ` View them all in a browser: ${captureGalleryUrl}` : ''}`
        });
        return forgeToolResponse(capturePacket, captureContent);
      },
      forge_artifact_get: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
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
              message: 'This workspace belongs to a different project. Use a workspace_id from the current project.',
              retryable: false
            });
          }
          workspaceRevision = state.revision;
        } else {
          source = 'url_review';
          // Defense-in-depth: the R2 key below is scoped to the caller's own
          // tenant, so a cross-tenant read is already impossible — but the key
          // carries no project, so a same-tenant caller in a different project
          // could otherwise read a url_review artifact by guessing the (random)
          // workspace and artifact ids. If a binding was recorded at review
          // time, it is authoritative: assert both tenant AND project match.
          const owner = await lookupUrlReviewOwner(env, workspaceId);
          if (owner && (owner.tenantId !== identity.tenantId || owner.projectId !== identity.projectId)) {
            throw new ForgeError({
              code: 'FORGE_PERMISSION_DENIED',
              message: 'This url_review artifact belongs to a different project.',
              retryable: false
            });
          }
          // owner === null means no binding on record (pre-migration workspace or
          // a best-effort write that did not land): fall back to the tenant-scoped
          // R2 key path. Residual risk: same-tenant cross-project reads of such
          // legacy/unbound workspaces remain key-shape authorized only.
        }
        const object = await env.ARTIFACTS.get(
          `tenant/${identity.tenantId}/workspace/${workspaceId}/artifacts/${artifactId}`
        );
        if (!object) {
          throw new ForgeError({
            code: 'FORGE_ARTIFACT_NOT_FOUND',
            message: 'No artifact with this artifact_id exists in this workspace.',
            retryable: false
          });
        }
        const maxBytes = number(input.max_bytes);
        if (object.size > maxBytes) {
          throw new ForgeError({
            code: 'FORGE_OUTPUT_TRUNCATED',
            message: 'The artifact is larger than the requested max_bytes limit. Raise max_bytes and retry.',
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
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id) as WorkspaceId;
        const idempotencyKey = idempotency(input.idempotency_key);
        const request = await (await authorizedCoordinator(env, identity, workspaceId)).requestDestroy({
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey,
          force: Boolean(input.force)
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
        await this.recordAudit(
          'workspace.destroy',
          identity.tenantId,
          { forced: Boolean(input.force), preserveArtifacts: Boolean(input.preserve_artifacts) },
          { workspaceId }
        );
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
