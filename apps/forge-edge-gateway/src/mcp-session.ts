import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import {
  ForgeError,
  toForgeError,
  ids,
  workspaceIdFromIdempotency,
  type ProcessId,
  type OperationId,
  type CredentialProfileId,
  type ProjectId,
  type SecretId,
  type TenantId,
  type WorkspaceId
} from '@forge/core';
import { issueCapability } from '@forge/capabilities';
import { registerForgeToolsV1, type ToolCallTelemetry } from '@forge/mcp-adapter-v1';
import { ToolCallTracker, hashArgs } from './telemetry';
import { forgeToolResponse, type ForgeToolHandlers, AGENT_OUTPUT_SPILL_BYTES, AGENT_OUTPUT_TAIL_BYTES, tailBytes, utf8Bytes } from '@forge/mcp-core';
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
import { classifyCommand, assertPublicHost, assertForgeBranch } from '@forge/policy';
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
  promoteStagedRef,
  repositoryAccessDiagnosis,
  markApprovalApproved,
  requestApproval,
  requireApproval,
  githubRequestForWorkspace
} from './github';
import { createDeferredAction, listDeferredActionsForWorkspace } from './deferred-actions';
import { autoPushForgeBranchesEnabled, isAgentForgeBranch } from './auto-push-policy';
import { commitFilesToBranch, RemoteCommitConflict } from '@forge/git-github';
import { durabilityNextStep, describeDurability, type DurabilityVerdict } from './durability';
import { isTextualArtifact } from './artifact-content';
import { normalizeRepoPath } from './repo-paths';
import { appendWorkspaceActivity, listWorkspaceActivity } from './workspace-activity';
import { buildLiveWorkspaceList, buildWorkspaceObserverDetail } from './observer-api';

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

/** Prefer the first https://…workers.dev URL wrangler prints after a deploy. */
function parseWorkersDevUrl(output: string): string | null {
  const match = output.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev(?:\/[^\s"'<>]*)?/i);
  return match?.[0]?.replace(/[),.;]+$/u, '') ?? null;
}

function parseWranglerWorkerName(output: string): string | null {
  const published = output.match(/Published\s+([A-Za-z0-9][A-Za-z0-9._-]*)/i);
  if (published?.[1]) return published[1];
  const deployed = output.match(/(?:Deployed|Uploading)\s+([A-Za-z0-9][A-Za-z0-9._-]*)/i);
  return deployed?.[1] ?? null;
}

async function spillTextArtifact(
  env: Env,
  identity: { tenantId: string },
  workspaceId: string,
  kind: string,
  text: string,
  contentType = 'text/plain; charset=utf-8'
): Promise<{ artifact_id: string; size_bytes: number; sha256: string }> {
  const artifactId = ids.artifact() as import('@forge/core').ArtifactId;
  const bytes = new TextEncoder().encode(text).buffer;
  const store = new R2ArtifactStore(env.ARTIFACTS);
  const ref = await store.put({
    id: artifactId,
    tenantId: identity.tenantId as import('@forge/core').TenantId,
    workspaceId: workspaceId as import('@forge/core').WorkspaceId,
    kind,
    contentType,
    bytes,
    metadata: { kind, workspace_id: workspaceId }
  });
  return { artifact_id: ref.id, size_bytes: ref.sizeBytes, sha256: ref.sha256 };
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
/**
 * Who owns a workspace, straight from D1.
 *
 * The artifact read used to answer this by asking the workspace's own Durable
 * Object. That is a liveness dependency in the one code path that exists for
 * when the workspace is NOT healthy: a recovery export written precisely
 * because push was blocked became unreadable the moment the workspace it
 * described stopped answering. D1 holds the same tenant/project binding and
 * does not depend on the container, so authorization survives the outage the
 * recovery path is for.
 */
async function lookupWorkspaceOwner(
  env: Pick<Env, 'METADATA'>,
  workspaceId: string
): Promise<{ tenantId: string; projectId: string } | null> {
  try {
    const row = await env.METADATA.prepare(
      'SELECT tenant_id, project_id FROM workspaces WHERE id = ?1'
    ).bind(workspaceId).first<{ tenant_id: string; project_id: string }>();
    return row ? { tenantId: row.tenant_id, projectId: row.project_id } : null;
  } catch (error) {
    console.warn('forge_workspace_owner_read_failed', {
      workspaceId,
      reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
    });
    return null;
  }
}

/** Bound a Durable Object read so an unreachable workspace cannot hang a request. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

type CompactWorkspaceState = {
  requestedRef: string;
  currentCommit?: string;
  baseCommit?: string;
  hasUnpushedWork?: boolean;
  currentBranch?: string;
};

async function outgoingComparisonRef(workspace: DurableObjectStub<WorkspaceCoordinator>, providedBase?: string): Promise<string> {
  const state = (await workspace.getState({ compact: true })) as CompactWorkspaceState;
  if (providedBase && providedBase !== state.requestedRef && providedBase !== 'main') {
    throw new ForgeError({
      code: 'FORGE_GIT_PUSH_BLOCKED',
      message: 'Outgoing diffs must compare against the workspace requestedRef recorded at creation.',
      retryable: false,
      details: {
        requestedRef: state.requestedRef,
        providedBase,
        head: state.currentCommit ?? null,
        baseCommit: state.baseCommit ?? null
      }
    });
  }
  return state.requestedRef;
}

/**
 * Persist the durability verdict from any mutating tool onto the task, and
 * hand the agent one unambiguous sentence about where the work lives.
 *
 * Previously only `forge_git_commit` recorded `remoteBranchSha`. Every file
 * tool auto-commits and auto-pushes through a different path, so an agent that
 * did the whole job with `forge_files_write*` — the documented way to edit —
 * genuinely landed its work on origin but left `remoteBranchSha` unset. Task
 * completion then refused with "the feature branch is not verified on origin",
 * about a branch that was on origin. That false blocker is its own source of
 * flailing, and it hid the true one.
 */
async function applyDurability<T extends Record<string, unknown>>(
  env: Env,
  workspaceId: WorkspaceId,
  result: T
): Promise<T & { next_step?: string }> {
  const verdict = durabilityOf(result);
  if (!verdict) return result;
  if (verdict.on_remote && verdict.remote_sha) {
    await recordTaskRemoteSha(env, workspaceId, verdict.remote_sha);
  }
  const existing = typeof result.next_step === 'string' ? `${result.next_step} ` : '';
  return { ...result, next_step: `${existing}${durabilityNextStep(verdict)}` };
}

/** The verdict fields, lifted out of a coordinator result for re-emission. */
function durabilityFields(value: object): Partial<DurabilityVerdict> {
  const verdict = durabilityOf(asRecord(value));
  return verdict ?? {};
}

/** Read a durability verdict off a coordinator result, if it carries one. */
function durabilityOf(value: Record<string, unknown>): DurabilityVerdict | undefined {
  const state = value.durability;
  if (state !== 'local_only' && state !== 'remote_branch' && state !== 'pull_request' && state !== 'failed_recovered') {
    return undefined;
  }
  const outcome = value.mutationOutcome;
  return {
    mutationOutcome:
      outcome === 'unchanged' || outcome === 'workspace_changed' || outcome === 'committed_local' ||
      outcome === 'pushed_remote' || outcome === 'unknown'
        ? outcome
        : 'unknown',
    durability: state,
    on_remote: value.on_remote === true,
    durability_statement: String(value.durability_statement ?? ''),
    ...(typeof value.remote_branch === 'string' ? { remote_branch: value.remote_branch } : {}),
    ...(typeof value.remote_sha === 'string' ? { remote_sha: value.remote_sha } : {})
  };
}

async function recordTaskRemoteSha(env: Env, workspaceId: WorkspaceId, remoteSha: string): Promise<void> {
  await new D1TaskStore(env.METADATA).getByWorkspace(workspaceId).then(async (task) => {
    if (!task) return;
    const now = new Date().toISOString();
    await new D1TaskStore(env.METADATA).put({
      ...task,
      remoteBranchSha: remoteSha,
      pushedAt: now,
      updatedAt: now
    });
  }).catch(() => undefined);
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

/** Git's own object id for a blob: sha1("blob <bytes>\0" + content). */
async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const buffer = new Uint8Array(header.length + body.length);
  buffer.set(header);
  buffer.set(body, header.length);
  const digest = await crypto.subtle.digest('SHA-1', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class ForgeMcpSession extends McpAgent<Env, unknown, SessionProps> {
  /**
   * Commit anything the container wrote outside forge_edit.
   *
   * A shell command that edits files — a formatter, a codemod, a generator —
   * would otherwise leave work in the only place that is not durable, and the
   * next sync would reset over it. Committing it makes the container's output
   * as safe as an edit, with no extra step for the agent to remember.
   */
  private async ingestContainerWrites(
    env: Env,
    identity: SessionProps,
    workspaceId: string,
    workspace: Awaited<ReturnType<typeof authorizedCoordinator>>,
    reason: string
  ): Promise<{ committed: boolean; commit_sha?: string; paths: string[]; truncated: boolean }> {
    const collected = await workspace.worktreeChanges({}).catch(() => ({ changes: [], truncated: false, baseBlobs: {} as Record<string, string> }));
    if (!collected.changes.length) return { committed: false, paths: [], truncated: collected.truncated };
    const state = (await workspace.getState()) as { repository: RepositoryRef; currentBranch?: string };
    const branch = state.currentBranch;
    if (!branch || !isAgentForgeBranch(branch)) return { committed: false, paths: [], truncated: collected.truncated };
    const request = await githubRequestForWorkspace(env, identity, { repository: state.repository });
    const result = await commitFilesToBranch(request, {
      owner: state.repository.owner,
      repo: state.repository.name,
      branch,
      message: `chore: ${reason}`.slice(0, 500),
      files: collected.changes,
      // The container edited from its own HEAD; if origin moved past that,
      // this content would revert the difference rather than add to it.
      expectedBlobs: collected.baseBlobs
    });
    if (result.commitSha) await recordTaskRemoteSha(env, workspaceId as WorkspaceId, result.commitSha);
    await workspace.syncToRemoteHead().catch(() => undefined);
    return {
      committed: Boolean(result.commitSha),
      ...(result.commitSha ? { commit_sha: result.commitSha } : {}),
      paths: result.paths,
      truncated: collected.truncated
    };
  }

  server = new McpServer(
    { name: 'Forge MCP', version: '0.1.0' },
    {
      instructions: [
        'Forge is a remote development computer. There is no push step and no local-only state: forge_edit commits straight to GitHub on your branch, so an edit either lands on origin or does not happen.',
        '1. forge_workspace_create — it cuts your branch for you. You never choose, create or switch branches.',
        '2. Read with forge_context_get / forge_files_read / forge_files_list. Edit with forge_edit (one call, many files; content:null deletes). Each call returns commit_url — that IS the durable record.',
        '3. Run checks with forge_shell. The container is a cache of what is already on GitHub; if it is ever stale it re-syncs itself.',
        '4. When the work is good, ask the human, then forge_merge — it opens the pull request and returns one approval link. Echo the link only.',
        '5. There is nothing to push, sync, rebase or recover. If forge_edit reports a conflict, re-read those paths and edit again.',
        '6. Deploys: forge_cloudflare_deploy → echo deploy_receipt.verified_url only. Never invent URLs.'
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
    const workspaceId = typeof event.input.workspace_id === 'string' && event.input.workspace_id.trim()
      ? event.input.workspace_id.trim()
      : undefined;
    const waitUntil = (this.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil;
    waitUntil?.(
      appendWorkspaceActivity(this.env, {
        tenantId: identity.tenantId,
        projectId: identity.projectId,
        workspaceId: workspaceId ?? null,
        tool: event.tool,
        status: event.status,
        durationMs: event.durationMs,
        errorCode: event.errorCode
      }).catch(() => undefined)
    );
    if (workspaceId) {
      waitUntil?.(
        coordinator(this.env, workspaceId).appendLiveActivity({
          tool: event.tool,
          status: event.status,
          durationMs: event.durationMs,
          errorCode: event.errorCode
        }).catch(() => undefined)
      );
    }
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
          `Start a coding task on ${repository}: ${task}. Prefer forge_task_create, then forge_workspace_create (it waits until ready — do not poll-loop) and reuse workspace_id. Read repository instructions and any parallax/ files before changes. Implement and verify, inspect with forge_git_diff scope:outgoing, then forge_merge. Tell me it is submitted and where to approve it, then destroy the workspace.`
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
          } once tests pass. Run the tests and confirm they are green, inspect the outgoing diff with forge_git_diff, then call forge_merge. It stages the branch and queues the draft pull request for me to approve whenever I get to it, so do not block waiting for an approval — report that it is submitted, tell me where to review it, and destroy the workspace.`
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
          const backup: { pushed: boolean; ref?: string; reason?: string } = await coordinator(env, reapedId).durablePushBeforeTeardown().catch((error) => ({
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
        git: {
          immutable_base_commit: true,
          workspace_proof: true,
          auto_push_forge_branches: 'reported_via_mutation_outcome',
          mutation_outcomes: ['unchanged', 'workspace_changed', 'committed_local', 'pushed_remote', 'unknown'],
          durability_states: ['local_only', 'remote_branch', 'pull_request', 'failed_recovered'],
          branch_push: 'approval_required',
          draft_pull_request: 'approval_required',
          submit_requires_feature_branch_on_origin: true,
          direct_merge: 'disabled'
        },
        processes: { managed_status: true, persistent_logs: true, preview_requires_exact_process_id: true },
        deployment: {
          cloudflare_wrangler: 'forge_cloudflare_deploy_only',
          ungated_wrangler_shell: 'blocked_requires_approval',
          requires_attached_secret_keys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
          live_claim_requires: 'deploy_receipt.verified_url'
        },
        recovery: {
          checkpoint: true,
          work_export: true,
          destruction_with_uncommitted_or_unpushed_work: 'blocked'
        },
        claims: {
          never_invent_workers_dev_urls: true,
          echo_only_tool_receipts: ['submission_receipt', 'deploy_receipt', 'remoteBranch']
        },
        observer: { read_only_tools: ['forge_observer_workspaces', 'forge_observer_workspace', 'forge_observer_activity'], live_portal: '/app/live' }
      }),
      forge_observer_workspaces: async () => {
        const identity = this.identity();
        return asRecord(await buildLiveWorkspaceList(env, identity.tenantId));
      },
      forge_observer_workspace: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        return asRecord(await buildWorkspaceObserverDetail(env, identity.tenantId, workspaceId));
      },
      forge_observer_activity: async (input) => {
        const identity = this.identity();
        const workspaceId = input.workspace_id === undefined
          ? undefined
          : await resolveWorkspaceId(env, identity, input.workspace_id);
        const limit = input.limit === undefined ? 40 : Number(input.limit);
        const since = input.since === undefined ? undefined : text(input.since);
        const activity = await listWorkspaceActivity(env, identity.tenantId, {
          workspaceId,
          limit: Number.isFinite(limit) ? limit : 40,
          since
        });
        return { activity, returned: activity.length };
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
        if (input.attached === false) {
          await vaultService(env).detach(identity.tenantId as TenantId, secretId, workspaceId);
          return { attached: false, secret_id: secretId, workspace_id: workspaceId };
        }
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
      forge_workspace_snapshot: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id));
        return asRecord(await workspace.checkpoint({ name: input.name ? text(input.name) : undefined }));
      },
      forge_workspace_restore: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id));
        return asRecord(await workspace.restoreCheckpoint({
          snapshotId: text(input.snapshot_id),
          expectedRevision: optionalNumber(input.expected_revision)
        }));
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
      forge_task_create: async (input) => {
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
        const mode = input.mode === undefined ? 'full' : text(input.mode);
        if (mode === 'full') return asRecord(task);
        if (mode === 'summary') {
          const summary = summarizeTask(task);
          const ttlMinutes = Math.round(slotTtlMs(env) / 60_000);
          return asRecord({
            ...summary,
            sessionBudget: {
              workspaceIdleTtlMinutes: ttlMinutes,
              note: task.workspaceId
                ? `An idle workspace is reclaimed after ~${ttlMinutes} minutes of inactivity. Push the forge/ branch and call forge_task_update before then, or send any tool call to reset the idle clock.`
                : 'No workspace attached yet.'
            }
          });
        }
        // mode === 'resume'
        let workspaceState: Record<string, unknown> | null = null;
        let gitSummary: Record<string, unknown> | null = null;
        const targetWorkspaceId = input.workspace_id ? text(input.workspace_id) : task.workspaceId;
        if (targetWorkspaceId) {
          try {
            const workspace = await authorizedCoordinator(env, identity, targetWorkspaceId);
            const state = await workspace.getState({ compact: true });
            const stateRecord = state as unknown as Record<string, unknown>;
            workspaceState = {
              workspaceId: state.id,
              state: state.state,
              currentBranch: state.currentBranch,
              currentCommit: state.currentCommit,
              revision: state.revision,
              hasUnpushedWork: state.hasUnpushedWork,
              dependencyState: stateRecord.dependencyState ?? null,
              activeProcessIds: stateRecord.activeProcessIds ?? [],
              processes: stateRecord.processes ?? [],
              allowedNextActions: stateRecord.allowedNextActions ?? [],
              next_step: stateRecord.next_step ?? null
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
      forge_task_update: async (input) => {
        const identity = this.identity();
        const store = new D1TaskStore(env.METADATA);
        let task = await this.loadTask(text(input.task_id) as TaskId);
        assertTaskOwnership(task, { tenantId: identity.tenantId as TenantId });
        const hasHandoff = input.handoff_summary !== undefined;
        const hasOutcome = input.outcome !== undefined;
        if (!hasHandoff && !hasOutcome) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'Provide outcome and/or handoff_summary (+ next_steps).',
            retryable: false,
            details: { taskId: task.id }
          });
        }
        if (hasHandoff) {
          const nextSteps = (input.next_steps as string[] | undefined) ?? [];
          if (nextSteps.length === 0) {
            throw new ForgeError({
              code: 'FORGE_VALIDATION_FAILED',
              message: 'handoff_summary requires next_steps (1–20 items).',
              retryable: false,
              details: { taskId: task.id }
            });
          }
          const handoff: TaskHandoff = {
            summary: text(input.handoff_summary),
            nextSteps,
            ...(input.key_learnings ? { keyLearnings: input.key_learnings as string[] } : {}),
            ...(input.modified_files ? { modifiedFiles: input.modified_files as string[] } : {}),
            ...(input.blocked_by ? { blockedBy: text(input.blocked_by) } : {}),
            createdAt: new Date().toISOString(),
            authorAgent: 'chatgpt'
          };
          task.handoff = handoff;
          task.updatedAt = new Date().toISOString();
          task.revision += 1;
          if (!hasOutcome) {
            await store.put(task);
            return {
              task_id: task.id,
              recorded: true,
              handoff_created_at: handoff.createdAt,
              revision: task.revision,
              next_step: 'Handoff recorded. Call forge_task_get with mode:resume in a fresh session to continue.'
            };
          }
        }
        const outcome = text(input.outcome) as TaskState;
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
        const queued = updated.workspaceId
          ? await listDeferredActionsForWorkspace(env, identity.tenantId, updated.workspaceId)
              .then((actions) => actions.filter((action) => action.state === 'awaiting_approval' || action.state === 'failed'))
              .catch(() => [])
          : [];
        return {
          task_id: updated.id,
          state: updated.state,
          revision: updated.revision,
          ...(updated.handoff ? { handoff_created_at: updated.handoff.createdAt } : {}),
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
        if (state === 'ready') {
          await coordinator(env, workspaceId).recordPushAuthProbe().catch(() => undefined);
        }
        const readyState = state === 'ready'
          ? await coordinator(env, workspaceId).getState({ compact: true }).catch(() => undefined)
          : undefined;
        const branch = readyState && typeof readyState === 'object' && 'currentBranch' in readyState
          ? String((readyState as { currentBranch?: string }).currentBranch ?? '')
          : undefined;
        const branch_policy = readyState && typeof readyState === 'object' && 'branch_policy' in readyState
          ? (readyState as { branch_policy?: unknown }).branch_policy
          : undefined;
        return {
          workspace_id: workspaceId,
          state,
          operation_id: result.operationId,
          workspace_revision: result.revision,
          ...(branch ? { current_branch: branch } : {}),
          ...(branch_policy ? { branch_policy } : {}),
          ...(credentialProfileId ? { credential_profile_id: credentialProfileId } : {}),
          next_step: state === 'ready'
            ? `Ready on ${branch || 'forge/…'}. Edit with forge_edit — it commits to GitHub, no push needed. Reuse this workspace_id.`
            : state === 'failed'
              ? 'Provisioning failed. Read forge_workspace_get for the reason; do not keep polling.'
              : `Still provisioning after the wait budget. Call forge_workspace_get with this workspace_id to check again — it is usually ready within a minute of creation.`
        };
      },
      forge_workspace_get: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).getState({
          compact: Boolean(input.compact)
        }));
      },
      forge_operation_get: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).operationGet({
          operationId: text(input.operation_id) as OperationId
        }));
      },
      forge_files_list: async (input) => {
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
        const readWorkspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const workspace = await authorizedCoordinator(env, identity, readWorkspaceId);
        const readOne = {
          startLine: optionalNumber(input.start_line),
          endLine: optionalNumber(input.end_line),
          maxBytes: perFileMaxBytes
        };
        // Single path keeps the original flat shape; multiple returns a files
        // array with per-file errors so one missing file does not fail the batch.
        if (paths.length === 1) {
          const single = asRecord(await workspace.filesRead({ path: paths[0] as string, ...readOne }));
          // Only a complete read establishes what the agent saw; a range or a
          // truncated read must not license a whole-file overwrite.
          if (typeof single.content === 'string' && !single.truncated && readOne.startLine === undefined && readOne.endLine === undefined) {
            await workspace.rememberReads({
              entries: [{ path: normalizeRepoPath(paths[0] as string), sha: await gitBlobSha(single.content) }]
            });
          }
          return single;
        }
        const files = await Promise.all(
          paths.map(async (path) => {
            try {
              const one = asRecord(await workspace.filesRead({ path, ...readOne }));
              if (typeof one.content === 'string' && !one.truncated && readOne.startLine === undefined && readOne.endLine === undefined) {
                await workspace.rememberReads({ entries: [{ path: normalizeRepoPath(path), sha: await gitBlobSha(one.content) }] });
              }
              return { ...one, path };
            } catch (error) {
              // Surface a real ForgeErrorCode so an agent keying on codes never
              // meets an undocumented one.
              return { path, error: toForgeError(error).code, message: error instanceof Error ? error.message.slice(0, 300) : 'The read failed for an unknown reason.' };
            }
          })
        );
        return { files };
      },
      forge_edit: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const workspace = await authorizedCoordinator(env, identity, workspaceId);
        const state = await withDeadline(
          (async () => (await workspace.getState()) as { repository: RepositoryRef; currentBranch?: string; baseCommit?: string; currentCommit?: string })(),
          15_000
        );
        if (!state) {
          throw new ForgeError({
            code: 'FORGE_WORKSPACE_NOT_READY',
            message: 'The workspace did not respond in time, so Forge cannot tell which branch to commit to. Nothing was written. Retry the same call.',
            retryable: true,
            details: { workspaceId }
          });
        }
        const branch = state.currentBranch;
        if (!branch || !isAgentForgeBranch(branch)) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'This workspace has no agent branch to edit. Create the workspace through forge_workspace_create, which cuts one for you.',
            retryable: false
          });
        }
        const files = (input.files as Array<{ path: string; content: string | null }>).map((file) => ({
          path: normalizeRepoPath(text(file.path)),
          content: file.content === null ? null : text(file.content)
        }));
        const duplicate = files.map((f) => f.path).find((path, index, all) => all.indexOf(path) !== index);
        if (duplicate) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `"${duplicate}" appears twice in one edit. Send each path once — the last write would silently win.`,
            retryable: false
          });
        }
        const message = input.message === undefined
          ? `edit: ${files.length} file${files.length === 1 ? '' : 's'}`
          : text(input.message);

        const request = await githubRequestForWorkspace(env, identity, { repository: state.repository });
        let result;
        try {
          result = await commitFilesToBranch(request, {
            owner: state.repository.owner,
            repo: state.repository.name,
            branch,
            message,
            files,
            expectedBlobs: await workspace.seenBlobs({ paths: files.map((file) => file.path) }),
            // The agent branch is cut inside the container, so GitHub has not
            // seen it until the first edit lands.
            baseSha: state.baseCommit ?? state.currentCommit,
            requireKnownBase: true
          });
        } catch (error) {
          if (error instanceof RemoteCommitConflict) {
            throw new ForgeError({
              code: 'FORGE_FILE_CONFLICT',
              message: error.message,
              retryable: false,
              details: { conflictingPaths: error.conflictingPaths, branch }
            });
          }
          throw error;
        }

        // The commit is on origin before this call returns, so durability is
        // settled here — there is no later push that could fail and strand it.
        const verdict = describeDurability({
          branch,
          commit: result.commitSha ?? result.parentSha,
          hasUnpushedWork: false,
          pushVerified: true,
          remoteSha: result.commitSha ?? result.parentSha,
          committed: !result.unchanged
        });
        if (result.commitSha) {
          await recordTaskRemoteSha(env, workspaceId as WorkspaceId, result.commitSha);
        }
        // What we just wrote is now what is on the branch, so a second edit to
        // the same path does not need an intervening read.
        await workspace.forgetReads({ paths: files.filter((file) => file.content === null).map((file) => file.path) });
        await workspace.rememberReads({
          entries: await Promise.all(
            files
              .filter((file) => file.content !== null)
              .map(async (file) => ({ path: file.path, sha: await gitBlobSha(file.content as string) }))
          )
        });
        // Best effort: bring the container's checkout in line so forge_run
        // tests what was just committed. A failure here costs nothing — the
        // work is already safe on GitHub and the container is a cache.
        const synced = await workspace.syncToRemoteHead().then(() => true).catch(() => false);

        return {
          ...verdict,
          ...(result.commitSha ? { commit_sha: result.commitSha } : {}),
          ...(result.commitSha
            ? { commit_url: `https://github.com/${state.repository.owner}/${state.repository.name}/commit/${result.commitSha}` }
            : {}),
          branch,
          paths: result.paths,
          rebased: result.rebased,
          workspace_synced: synced,
          next_step: result.unchanged
            ? 'Nothing changed — the files already had this content. Continue or call forge_merge.'
            : `Committed to origin/${branch}. Run checks with forge_shell, then forge_merge when ready.${synced ? '' : ' The container checkout is stale; forge_shell will re-sync.'}`
        };
      },
      forge_diff_metadata: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id));
        const base = text(input.base);
        const outgoing = await workspace.gitOutgoingDiff({ base: await outgoingComparisonRef(workspace, base), maxBytes: 256_000 });
        const compact = analyzeDiff(outgoing.diff);
        return asRecord(compact);
      },
      forge_context_get: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id));
        // git's file list, not a filesystem walk: node_modules used to consume
        // the whole bounded result, so the selector never saw a source file.
        let files = await workspace.listRepositoryFiles({ limit: 10_000 }).catch(() => [] as string[]);
        if (!files.length) {
          const tree = await workspace.filesTree({ path: '/workspace/repo', depth: 20, limit: 10_000 });
          const entries = (tree as { entries?: Array<{ path?: string; name?: string; type?: string }> }).entries ?? [];
          files = entries
            .filter((e) => e.type !== 'directory' && e.path)
            .map((e) => e.path!.replace(/^\/workspace\/repo\//, ''));
        }
        files = files.filter((p) => p && !p.startsWith('.'));
        const response = selectContext({
          goal: text(input.goal),
          files,
          likelyPaths: (input.likely_paths as string[] | undefined) ?? [],
          maxResults: number(input.max_results)
        });
        return asRecord(response);
      },
      forge_shell: async (input) => {
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
            if (input.mode === 'read_only') {
              throw new ForgeError({
                code: 'FORGE_VALIDATION_FAILED',
                message: 'async:true cannot be combined with mode:read_only. Use a foreground read-only command, or omit mode for a managed process.',
                retryable: false,
                details: { allowedNextActions: ['forge_shell'] }
              });
            }
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
                details: { replay: Boolean(procRecord.replay), allowedNextActions: ['forge_workspace_get', 'forge_process_list'] }
              });
            }
            const status = String(value.status ?? procRecord.status ?? 'running');
            return {
              processId,
              status,
              command,
              async: true,
              replay: Boolean(procRecord.replay),
              replayed: Boolean(procRecord.replayed ?? procRecord.replay),
              operationId: procRecord.operationId,
              workspaceRevision: procRecord.workspaceRevision,
              mutatesFilesystem: value.mutatesFilesystem ?? procRecord.mutatesFilesystem,
              allowedNextActions: ['forge_process_wait', 'forge_process_logs', 'forge_process_get'],
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
            approved: claimedApproval,
            mode: input.mode === 'read_only' || input.mode === 'mutating' ? input.mode : undefined
          });
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, true, { reusable: true });
          let stdout = 'stdout' in result ? String(result.stdout ?? '') : '';
          let stderr = 'stderr' in result ? String(result.stderr ?? '') : '';
          if (attached.redact.size > 0) {
            stdout = await vaultService(env).redactOutput(stdout, identity.tenantId as TenantId, workspaceId);
            stderr = await vaultService(env).redactOutput(stderr, identity.tenantId as TenantId, workspaceId);
          }
          const compact = input.compact !== false;
          const combinedBytes = utf8Bytes(stdout) + utf8Bytes(stderr);
          let outputArtifactId: string | undefined;
          if (combinedBytes > AGENT_OUTPUT_SPILL_BYTES) {
            const spilled = await spillTextArtifact(
              env,
              identity,
              workspaceId,
              'shell-output',
              `===STDOUT===\n${stdout}\n===STDERR===\n${stderr}\n`
            );
            outputArtifactId = spilled.artifact_id;
          }
          const base = asRecord(result);
          const { checkpoint: _checkpoint, stdout: _s, stderr: _e, ...rest } = base;
          const exitCode = 'exitCode' in result ? Number(result.exitCode) : undefined;
          // Anything this command wrote lives only in the container, which is
          // the one place that is not durable. Commit it before returning, so
          // a formatter or codemod cannot leave work to be lost at the next
          // sync — and so the agent is never holding changes it must remember
          // to save.
          const ingested = input.mode === 'read_only'
            ? { committed: false, paths: [] as string[], truncated: false }
            : await this.ingestContainerWrites(env, identity, workspaceId, workspace, `${command.slice(0, 80)}`)
                .catch(() => ({ committed: false, paths: [] as string[], truncated: false, failed: true }));
          const wrote = ingested.paths.length
            ? {
                committed_files: ingested.paths,
                ...('commit_sha' in ingested && ingested.commit_sha ? { commit_sha: ingested.commit_sha } : {}),
                ...('failed' in ingested && ingested.failed
                  ? { committed_files_warning: 'This command changed files that Forge could not commit to GitHub. They exist only in the container. Re-apply them with forge_edit.' }
                  : {})
              }
            : {};
          if (compact) {
            return {
              ...rest,
              ...wrote,
              exitCode,
              compact: true,
              truncated: Boolean(result.truncated) || Boolean(outputArtifactId),
              stdout_tail: tailBytes(stdout, AGENT_OUTPUT_TAIL_BYTES),
              stderr_tail: tailBytes(stderr, AGENT_OUTPUT_TAIL_BYTES),
              ...(outputArtifactId
                ? {
                    output_artifact_id: outputArtifactId,
                    next_step: `Full output in ${outputArtifactId} (forge_artifact_get). Do not invent missing log lines from the tails.`
                  }
                : {})
            };
          }
          return {
            ...rest,
            ...wrote,
            exitCode,
            compact: false,
            stdout,
            stderr,
            ...(outputArtifactId ? { output_artifact_id: outputArtifactId } : {})
          };
        } catch (error) {
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, false);
          throw error;
        }
      },
      forge_process_logs: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).processLogs({
          processId: text(input.process_id) as ProcessId,
          cursor: input.cursor ? text(input.cursor) : undefined
        }));
      },
      forge_process_list: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id));
        if (input.process_id) {
          return asRecord(await workspace.processGet({ processId: text(input.process_id) as ProcessId }));
        }
        return asRecord(await workspace.processList());
      },
      forge_process_stop: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id));
        const args = {
          processId: text(input.process_id) as ProcessId,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: idempotency(input.idempotency_key)
        };
        return asRecord(input.force ? await workspace.processCancel(args) : await workspace.processStop(args));
      },
      forge_process_wait: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, input.workspace_id))).processWait({
          processId: text(input.process_id) as ProcessId,
          timeoutMs: optionalNumber(input.timeout_ms) ?? 120_000
        }));
      },
      forge_deps_install: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
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
      forge_merge: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        // The branch is Forge's, not the agent's, so it does not have to know
        // or repeat it. If one is supplied it must be the workspace's own —
        // merging some other branch is never what was meant.
        const workspaceBranch = ((await (await authorizedCoordinator(env, identity, workspaceId)).getState()) as { currentBranch?: string }).currentBranch;
        const branch = input.branch === undefined ? (workspaceBranch ?? '') : text(input.branch);
        if (!branch) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'This workspace has no agent branch to merge. Nothing has been edited yet.',
            retryable: false
          });
        }
        if (workspaceBranch && branch !== workspaceBranch) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `This workspace is on ${workspaceBranch}, not ${branch}. Omit branch and Forge merges the one you have been editing.`,
            retryable: false,
            details: { workspaceBranch, requested: branch }
          });
        }
        assertForgeBranch(branch);
        const prBase = input.pr_base !== undefined
          ? text(input.pr_base)
          : (input.base !== undefined ? text(input.base) : 'main');
        const taskIdInput = input.task_id ? text(input.task_id) : null;
        let title = input.title === undefined ? '' : text(input.title);
        let body = input.body === undefined ? '' : text(input.body);

        const coordinator = await authorizedCoordinator(env, identity, workspaceId);
        const state = await coordinator.getState();
        const comparisonRef = await outgoingComparisonRef(coordinator, input.base !== undefined ? text(input.base) : undefined);

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
        const outgoing = await coordinator.gitOutgoingDiff({ base: comparisonRef, maxBytes: 48_000 }).catch(() => undefined);
        const diff = outgoing?.diff ?? '';
        const filesChanged = outgoing?.totalFiles ?? 0;
        // Nothing to review is a mistake worth naming, not an empty pull request
        // for someone to puzzle over later.
        if (filesChanged === 0) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `There is nothing to submit: ${branch} has no changes against ${comparisonRef}. Make the change first, then submit.`,
            retryable: false,
            details: {
              comparisonRef,
              prBase,
              requestedRef: comparisonRef,
              baseCommit: state.baseCommit ?? null,
              head: state.currentCommit ?? null
            }
          });
        }

        // Give the reviewer something readable to decide on. Best-effort: a
        // missing summariser must never be what stops work being submitted.
        if (!title.trim() && aiEnabled(env) && diff.trim()) {
          const summary = await summarizeDiffForPr(env, diff, { branch, base: prBase }).catch(() => undefined);
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

        let diffArtifactId: string | undefined;
        if (diff.trim() && utf8Bytes(diff) > 4_096) {
          const spilled = await spillTextArtifact(env, identity, workspaceId, 'submit-diff', diff, 'text/x-diff');
          diffArtifactId = spilled.artifact_id;
        }
        const approval = await requestApproval(
          env,
          identity,
          workspaceId,
          'work.submit',
          `Merge ${branch} into ${prBase}`,
          {
            branch,
            base: prBase,
            comparisonRef,
            title,
            body,
            commit: staged.commit,
            ...(diffArtifactId
              ? { diffArtifactId, diffTotals: { files: filesChanged, additions: outgoing?.totalAdditions ?? 0, deletions: outgoing?.totalDeletions ?? 0 } }
              : { diff: diff.slice(0, 48_000), diffTotals: { files: filesChanged, additions: outgoing?.totalAdditions ?? 0, deletions: outgoing?.totalDeletions ?? 0 } })
          }
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
          base: prBase,
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
          { branch, prBase, comparisonRef, stagedRef: staged.ref, commit: staged.commit, approvalId: approval.approval_id },
          { workspaceId }
        );
        const submittedAt = new Date().toISOString();
        await new D1TaskStore(env.METADATA).getByWorkspace(workspaceId).then(async (task) => {
          if (!task) return;
          await new D1TaskStore(env.METADATA).put({ ...task, submittedAt, updatedAt: submittedAt });
        }).catch(() => undefined);

        return {
          submitted: true,
          submission_receipt: {
            branch,
            remote_sha: staged.remote_sha,
            staged_ref: staged.ref,
            approval_id: approval.approval_id,
            approval_url: approval.approval_url,
            files_changed: filesChanged,
            feature_branch_on_origin: true as const
          },
          next_step: `Echo only submission_receipt to the human. Branch ${branch}@${staged.remote_sha} is on origin; approve at ${approval.approval_url}. Do not invent a workers.dev URL.`
        };
      },
      forge_cloudflare_deploy: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const command = input.command === undefined ? 'npx wrangler deploy' : text(input.command);
        const cwd = input.cwd === undefined ? '/workspace/repo' : text(input.cwd);
        const expectedUrl = input.expected_url === undefined ? undefined : text(input.expected_url);
        const decision = classifyCommand(command, 'development');
        if (decision.classification !== 'external_side_effect') {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'forge_cloudflare_deploy only runs wrangler deploy/publish/delete commands. Use forge_shell for probes (including --dry-run).',
            retryable: false
          });
        }
        if (/(^|\s)--dry-run(\s|$)/i.test(command)) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'Dry-run is not a deploy. Use forge_shell with wrangler deploy --dry-run instead.',
            retryable: false
          });
        }
        const attached = await vaultService(env).attachedEnv(identity.tenantId as TenantId, workspaceId);
        const token = attached.vars.CLOUDFLARE_API_TOKEN?.trim();
        const accountId = attached.vars.CLOUDFLARE_ACCOUNT_ID?.trim();
        if (!token || !accountId) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'Attach a Cloudflare vault secret that includes both CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (forge_secret_attach), then retry. Account pinning prevents deploying to the wrong Cloudflare account.',
            retryable: false,
            details: {
              has_token: Boolean(token),
              has_account_id: Boolean(accountId),
              next_step: 'Create the secret in /app/secrets or forge_secret_create, attach it, then call forge_cloudflare_deploy again.'
            }
          });
        }
        const approvalPayload = {
          command,
          cwd,
          accountId,
          expectedUrl: expectedUrl ?? null
        };
        let approvalId = input.approval_id ? text(input.approval_id) : undefined;
        if (!approvalId) {
          const approval = await requestApproval(
            env,
            identity,
            workspaceId,
            'cloudflare.deploy',
            `Deploy with wrangler to Cloudflare account ${accountId}`,
            approvalPayload
          );
          if (approval.already_approved) {
            approvalId = approval.approval_id;
            await requireApproval(env, identity, approvalId, workspaceId, 'cloudflare.deploy', approvalPayload);
          } else {
            const inline = await this.tryResolveApprovalInline(
              identity,
              approval,
              `Deploy with wrangler to Cloudflare account ${accountId}`
            );
            if (!inline) {
              throw new ForgeError({
                code: 'FORGE_APPROVAL_REQUIRED',
                message: 'Cloudflare deploy needs human approval. Open the approval URL, approve, then retry with approval_id.',
                retryable: false,
                details: { kind: 'approval', action: 'cloudflare.deploy', ...approval }
              });
            }
            approvalId = inline;
            await requireApproval(env, identity, approvalId, workspaceId, 'cloudflare.deploy', approvalPayload);
          }
        } else {
          await requireApproval(env, identity, approvalId, workspaceId, 'cloudflare.deploy', approvalPayload);
        }
        const workspace = await authorizedCoordinator(env, identity, workspaceId);
        const result = await workspace.shellExec({
          command,
          cwd,
          timeoutMs: 300_000,
          environment: {
            ...attached.vars,
            CLOUDFLARE_API_TOKEN: token,
            CLOUDFLARE_ACCOUNT_ID: accountId
          },
          networkPolicy: 'development',
          outputLimitBytes: 200_000,
          approved: true,
          mode: 'mutating'
        });
        const combined = `${result.stdout}\n${result.stderr}`;
        const redacted = await vaultService(env).redactOutput(combined, identity.tenantId as TenantId, workspaceId);
        if (result.exitCode !== 0) {
          if (approvalId) await completeApproval(env, approvalId, false);
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `Wrangler deploy failed (exit ${result.exitCode}). Do not claim the Worker is live.`,
            retryable: true,
            details: { exitCode: result.exitCode, output_tail: redacted.slice(-4_000) }
          });
        }
        const workerName = parseWranglerWorkerName(redacted);
        const publishedUrl = expectedUrl ?? parseWorkersDevUrl(redacted);
        let httpStatus: number | null = null;
        let verifiedUrl: string | null = null;
        if (publishedUrl) {
          try {
            const probe = await fetch(publishedUrl, {
              method: 'GET',
              redirect: 'follow',
              signal: AbortSignal.timeout(15_000)
            });
            httpStatus = probe.status;
            // Any HTTP response from the hostname proves the Worker route exists;
            // 404 app content still means the worker is deployed.
            verifiedUrl = publishedUrl;
          } catch {
            httpStatus = null;
            verifiedUrl = null;
          }
        }
        if (approvalId) await completeApproval(env, approvalId, true);
        await this.recordAudit(
          'cloudflare.deploy',
          identity.tenantId,
          { accountId, workerName, verifiedUrl, httpStatus, command },
          { workspaceId }
        );
        const deployReceipt = {
          account_id: accountId,
          worker_name: workerName,
          verified_url: verifiedUrl,
          http_status: httpStatus,
          command
        };
        let outputArtifactId: string | undefined;
        if (utf8Bytes(redacted) > AGENT_OUTPUT_SPILL_BYTES) {
          const spilled = await spillTextArtifact(env, identity, workspaceId, 'deploy-output', redacted);
          outputArtifactId = spilled.artifact_id;
        }
        const includeOutput = input.include_output === true;
        return {
          deployed: true,
          deploy_receipt: deployReceipt,
          ...(outputArtifactId ? { output_artifact_id: outputArtifactId } : {}),
          ...(includeOutput ? { stdout_tail: redacted.slice(-3_000) } : {}),
          next_step: verifiedUrl
            ? `Only claim this URL is live: ${verifiedUrl} (HTTP ${httpStatus}). Echo deploy_receipt only.${outputArtifactId ? ` Full logs: ${outputArtifactId}.` : ''}`
            : `Deploy succeeded but URL not verified. Do not invent workers.dev.${outputArtifactId ? ` Inspect ${outputArtifactId} via forge_artifact_get.` : ' Pass expected_url.'}`
        };
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
            forge_preview: async (input) => {
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
                  ? 'No dev server command was detected for this project, so there is nothing to screenshot. Start the server with forge_shell async:true, then call forge_preview again (omit preview_id) or pass preview_id once exposed.'
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
            message: 'This preview has expired. Call forge_preview again without a preview_id and Forge will bring a fresh one up.',
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
        let source: 'workspace' | 'url_review' | 'degraded_workspace' = 'workspace';
        // Bounded: a workspace that has stopped answering must not be able to
        // block the read of its own recovery artifact. On timeout we fall
        // through to the D1 binding, which carries the same tenant/project
        // facts without needing the container.
        const state = await withDeadline((async () => coordinator(env, workspaceId).tryGetState())(), 5_000);
        // D1 binding, consulted only when the coordinator did not answer. A
        // real container-backed workspace still authorizes on tenant AND
        // project — it just no longer needs to be alive to do it.
        const degradedOwner = state ? null : await lookupWorkspaceOwner(env, workspaceId);
        if (state || degradedOwner) {
          const ownerTenant = state ? state.tenantId : degradedOwner!.tenantId;
          const ownerProject = state ? state.projectId : degradedOwner!.projectId;
          if (ownerTenant !== identity.tenantId || ownerProject !== identity.projectId) {
            throw new ForgeError({
              code: 'FORGE_PERMISSION_DENIED',
              message: 'This workspace belongs to a different project. Use a workspace_id from the current project.',
              retryable: false
            });
          }
          workspaceRevision = state ? state.revision : null;
          if (!state) source = 'degraded_workspace';
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
        if (mimeType.startsWith('image/')) {
          return forgeToolResponse(value, [{
            type: 'image',
            data: base64(await object.arrayBuffer()),
            mimeType
          }]);
        }
        // Return the bytes. This used to hand back metadata only for anything
        // that was not an image, which made forge_work_export write-only: a
        // recovery patch is stored as text/plain, so the one artifact that
        // exists to rescue unpushed work could be created and described but
        // never read back. size_bytes is already bounded by max_bytes above.
        const bytes = await object.arrayBuffer();
        return isTextualArtifact(mimeType)
          ? { ...value, content: new TextDecoder().decode(bytes) }
          : { ...value, content_base64: base64(bytes) };
      },
      forge_artifact_upload: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, input.workspace_id);
        const artifactId = ids.artifact() as import('@forge/core').ArtifactId;
        const bytes = Uint8Array.from(atob(text(input.content_base64)), (c) => c.charCodeAt(0)).buffer;
        const store = new R2ArtifactStore(env.ARTIFACTS);
        const ref = await store.put({
          id: artifactId,
          tenantId: identity.tenantId as import('@forge/core').TenantId,
          workspaceId: workspaceId as import('@forge/core').WorkspaceId,
          kind: 'upload',
          contentType: text(input.content_type),
          bytes,
          metadata: (input.metadata as Record<string, string>) ?? {}
        });
        return {
          artifact_id: ref.id,
          key: ref.key,
          content_type: ref.contentType,
          size_bytes: ref.sizeBytes,
          sha256: ref.sha256
        };
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
      },
    };
  }
}
