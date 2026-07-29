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
import { assertCleanForMerge, verifyFeatureBranchOnOrigin } from './merge-guards';
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
import { resolveWorkspaceId, parseWorkspaceAddress, isWorkspaceId } from './workspace-resolve';
import { storeGallery } from './review-gallery';
import type { CommandClass } from '@forge/policy';
import type { Env } from './env';
import type { WorkspaceCoordinator } from './workspace-coordinator';
import { credentialService } from './credentials';
import { vaultService } from './vault';
import { reserveWorkspaceSlot, releaseWorkspaceSlot, reclaimStaleSlots, listSlotOccupants, slotTtlMs, workspaceCaps, TERMINAL_STATES } from './capacity';
import { snapshotsEnabled } from './snapshots';
import { aiEnabled, summarizeDiffForPr } from './ai';
import { registerLegacyWidgetStub } from './legacy-widget';
import {
  authorizeRepository,
  completeApproval,
  createDraftPullRequest,
  listAuthorizedRepositories,
  promoteStagedRef,
  repositoryAccessDiagnosis,
  repositoryWriteProof,
  markApprovalApproved,
  requestApproval,
  requireApproval,
  githubRequestForWorkspace
} from './github';
import { createDeferredAction, listDeferredActionsForWorkspace } from './deferred-actions';
import { autoPushForgeBranchesEnabled, isAgentForgeBranch } from './auto-push-policy';
import { commitFilesToBranch, createBranchRef, RemoteCommitConflict } from '@forge/git-github';
import {
  DURABILITY_STATES,
  MUTATION_OUTCOMES,
  durabilityNextStep,
  describeDurability,
  type DurabilityVerdict
} from './durability';
import { isTextualArtifact } from './artifact-content';
import { normalizeRepoPath, readableFile, toContainerPath } from './repo-paths';
import { GitHubReadUnavailable, resolveBranchTree, readBlobFromTree, listEntriesFromTree } from './github-reads';
import { hoistUniformFields } from './uniform-fields';
import { recordToolCall, recentToolCalls, priorIdenticalFailures, repeatCallGuidance } from './tool-call-log';
import { applyReplacements, ReplacementFailed } from './apply-replacements';
import { stripAnsi, summariseCommandOutput } from './command-summary';
import { appendWorkspaceActivity, listWorkspaceActivity } from './workspace-activity';
import { buildLiveWorkspaceList, buildWorkspaceObserverDetail } from './observer-api';
import { readPullRequestReadiness } from './github-pr-readiness';
import { deleteGitHubBranchIfUnchanged, listGitHubBranchesWithinBudget, liveWorkspaceBranches } from './github-branches';
import { readFragmentSource } from './github-fragment-source';
import { forgeStartSlug } from './forge-start-branch';
import { claimExternalMutation, readExternalMutationReceipt, recordExternalMutationReceipt } from './external-mutation-idempotency';

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
      message: 'This workspace belongs to a different project. Use owner/repo/branch (or none, to use the one you have open) to address a workspace in the current project instead.',
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

// The single `workspace` field ("owner/repo#branch", "owner/repo", or a bare
// branch) a tool input carries instead of an opaque workspace_id (see
// workspace-resolve.ts). Every workspace-scoped handler below passes this
// straight to resolveWorkspaceId; forge_artifact_get is the one exception
// that also threads workspace_id through (see its own handler).
function workspaceAddress(input: Record<string, unknown>): { workspace?: unknown } {
  return { workspace: input.workspace };
}

// True once the caller has given resolveWorkspaceId something to go on. Used
// where "nothing given" should mean "do not require exactly one workspace"
// rather than "resolve one" — e.g. forge_observer_activity, which is happy to
// report across every workspace when no address narrows it.
function hasWorkspaceAddress(input: Record<string, unknown>): boolean {
  return input.workspace !== undefined;
}

// Best-effort recovery of a successful call's workspace id from its own
// result, for the audit trail only (see onToolCallTelemetry) — never used to
// authorize or resolve anything. `result` is the adapter's response envelope
// (structuredContent, not the bare handler value); a handler's own return
// object almost always carries workspace_id or workspaceId as a receipt.
function workspaceIdFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== 'object') return undefined;
  const record = structured as Record<string, unknown>;
  const candidate = record.workspace_id ?? record.workspaceId;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
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
      message: `Outgoing diffs must compare against '${state.requestedRef}', the ref this workspace was created from, not '${providedBase}'. Pass base:'${state.requestedRef}', or omit base to use it automatically.`,
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
    // A failed collection is not the same as a clean tree. Let the caller
    // return an explicit durability warning instead of falsely claiming there
    // was nothing to persist.
    const collected = await workspace.worktreeChanges({});
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
        '1. forge_workspace_create — it cuts your branch for you. You never choose, create or switch branches. Optional: call forge_start first and pass its branch as ref — it creates the branch on GitHub before any workspace exists, so it is real on origin from the moment it exists at all.',
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
    registerForgeToolsV1(this.server, this.withRepeatDetection(this.handlers()), (event) => {
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
    // Most workspace-scoped tools no longer take workspace_id as input (see
    // workspace-resolve.ts) — they resolve it from owner/repo/branch instead —
    // so it is no longer reliably on event.input. It is on event.result
    // instead: every workspace-scoped handler still returns workspace_id or
    // workspaceId to the caller as a receipt (see invariant A's allowlist
    // decision), and this audit trail is exactly what forge_observer_activity
    // filters by workspace, so losing that association here would make that
    // tool worse at the one job it exists for.
    const workspaceId = (typeof event.input.workspace_id === 'string' && event.input.workspace_id.trim())
      ? event.input.workspace_id.trim()
      : workspaceIdFromResult(event.result);
    const waitUntil = (this.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil;
    // The payload trail. Written alongside the counter so a failure can be
    // diagnosed from exactly what the agent sent and exactly what it read
    // back, without waiting for someone to reproduce it.
    waitUntil?.(
      recordToolCall(this.env, {
        tenantId: identity.tenantId,
        projectId: identity.projectId,
        workspaceId: workspaceId ?? null,
        clientName,
        tool: event.tool,
        status: event.status,
        durationMs: event.durationMs,
        // A successful call whose payload drifted from its declared output
        // shape is recorded as such. It stays status:'success' — the agent got
        // a real result and must not be told otherwise — but the drift is
        // queryable here rather than waiting to be noticed by a human.
        errorCode: event.errorCode ?? (event.schemaDrift ? 'FORGE_OUTPUT_SCHEMA_DRIFT' : undefined),
        errorMessage:
          event.errorMessage ??
          (event.schemaDrift ? `Fields off declared shape: ${event.schemaDrift.join(', ')}` : undefined),
        request: event.input,
        response: event.result,
        argsHash: await hashArgs(event.input)
      }).catch(() => undefined)
    );
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
          `Start a coding task on ${repository}: ${task}. Prefer forge_task_create, then forge_workspace_create (it waits until ready — do not poll-loop) and reuse workspace_id. Read repository instructions and any parallax/ files before changes. Implement and verify, inspect with forge_diff_metadata, then forge_merge. Tell me it is submitted and where to approve it, then destroy the workspace.`
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
          } once tests pass. Run the tests and confirm they are green, inspect the outgoing change with forge_diff_metadata, then call forge_merge. It opens the draft pull request for me to approve whenever I get to it, so do not block waiting for an approval — report that it is submitted, tell me where to review it, and destroy the workspace.`
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

  /**
   * Tell an agent when it is looping, at the moment it loops.
   *
   * A strict host retries a failed call, often with identical arguments. The
   * error is correct each time and says nothing about the repetition, so the
   * agent has no signal that repeating is futile — which is how one bad call
   * becomes sixteen. Counting prior identical failures turns the loop itself
   * into information the agent can act on.
   *
   * The lookup runs only on the failing path, so a working session never pays
   * for it, and it can never turn a success into a failure.
   */
  private withRepeatDetection(handlers: ForgeToolHandlers): ForgeToolHandlers {
    const wrapped = {} as ForgeToolHandlers;
    for (const name of Object.keys(handlers) as Array<keyof ForgeToolHandlers>) {
      const original = handlers[name];
      wrapped[name] = (async (input: Record<string, unknown>) => {
        try {
          return await original(input);
        } catch (error) {
          const forge = toForgeError(error);
          try {
            const identity = this.identity();
            const argsHash = await hashArgs(input);
            const prior = await priorIdenticalFailures(this.env, {
              tenantId: identity.tenantId,
              tool: String(name),
              argsHash
            });
            if (prior >= 2) {
              throw new ForgeError({
                code: forge.code,
                message: `${forge.message} ${repeatCallGuidance(String(name), prior + 1)}`,
                retryable: false,
                ...(forge.operationId ? { operationId: forge.operationId } : {}),
                details: { ...(forge.details ?? {}), repeatedIdenticalFailures: prior + 1, stopRepeating: true }
              });
            }
          } catch (enrichment) {
            // Never let the loop detector mask the real failure.
            if (enrichment instanceof ForgeError && enrichment.details?.stopRepeating) throw enrichment;
          }
          throw forge;
        }
      }) as ForgeToolHandlers[typeof name];
    }
    return wrapped;
  }

  private handlers(): ForgeToolHandlers {
    const env = this.env;
    return {
      // Answers "what is true about this system", so every claim has to still
      // be true. The previous literal described the pre-remote-first Forge: it
      // told agents branch_push was approval_required and direct_merge was
      // disabled, when there is no push step at all and forge_pr merges. An
      // agent orienting itself here was sent looking for a stage that no longer
      // exists. The vocabularies now come from durability.ts rather than being
      // restated, so they cannot drift from the values actually returned.
      forge_capabilities: async () => ({
        model: 'remote_first',
        editing: {
          commits_straight_to_github: true,
          push_step: 'none',
          branch: 'cut_by_forge_workspace_create',
          conflict: 're_read_then_edit_again',
          container: 'cache_of_github_resyncs_itself'
        },
        git: {
          mutation_outcomes: MUTATION_OUTCOMES,
          durability_states: DURABILITY_STATES,
          merge: 'forge_merge_opens_pr_for_human_approval',
          pull_requests: 'forge_pr_can_list_status_merge_close',
          branches: 'forge_branches_can_list_and_delete'
        },
        processes: { managed_status: true, persistent_logs: true, preview_requires_exact_process_id: true },
        deployment: {
          cloudflare_wrangler: 'forge_cloudflare_deploy_only',
          ungated_wrangler_shell: 'blocked_requires_approval',
          requires_attached_secret_keys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
          live_claim_requires: 'deploy_receipt.verified_url'
        },
        claims: {
          never_invent_urls: true,
          echo_only_tool_receipts: ['submission_receipt', 'deploy_receipt', 'commit_url']
        },
        observer: { read_only_tools: ['forge_observer_workspaces', 'forge_observer_workspace', 'forge_observer_activity'], live_portal: '/app/live' }
      }),
      forge_observer_workspaces: async () => {
        const identity = this.identity();
        return asRecord(await buildLiveWorkspaceList(env, identity.tenantId));
      },
      forge_observer_workspace: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        return asRecord(await buildWorkspaceObserverDetail(env, identity.tenantId, workspaceId));
      },
      forge_observer_activity: async (input) => {
        const identity = this.identity();
        const workspaceId = hasWorkspaceAddress(input)
          ? await resolveWorkspaceId(env, identity, workspaceAddress(input))
          : undefined;
        const limit = input.limit === undefined ? 40 : Number(input.limit);
        const since = input.since === undefined ? undefined : text(input.since);
        // payloads:true answers "what were they sending", which is the only
        // view that explains a failure rather than counting it.
        if (input.payloads === true || input.errors_only === true) {
          const calls = await recentToolCalls(env, {
            tenantId: identity.tenantId,
            workspaceId,
            onlyErrors: input.errors_only === true,
            limit: Number.isFinite(limit) ? limit : 40
          });
          return {
            calls,
            returned: calls.length,
            note: 'Secret-shaped keys are redacted and long values previewed; request_bytes/response_bytes are the true sizes.'
          };
        }
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
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
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
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        return asRecord(await workspace.checkpoint({ name: input.name ? text(input.name) : undefined }));
      },
      forge_workspace_restore: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        return asRecord(await workspace.restoreCheckpoint({
          snapshotId: text(input.snapshot_id),
          expectedRevision: optionalNumber(input.expected_revision)
        }));
      },
      forge_repository_list: async () => {
        const identity = this.identity();
        const all = await listAuthorizedRepositories(env, identity.tenantId);
        if (all.length > 0) {
          // installation_id is GitHub's internal handle for the App install.
          // No Forge tool accepts one — forge_workspace_create takes
          // {provider, owner, name} — so it was 32 identical bytes per row
          // that an agent could not act on. Dropped, not hoisted.
          const withoutInstallId = all.map(({ installation_id: _installationId, ...rest }) => rest);
          const { rows: repositories, shared } = hoistUniformFields(withoutInstallId, [
            'last_verified_at',
            'default_branch'
          ]);
          return { repositories, ...shared };
        }
        const repositories = all;
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
        // The task itself already remembers which workspace it last touched —
        // a better default than "the tenant's one open workspace" (what
        // resolveWorkspaceId would fall back to with nothing given), since a
        // task can outlive the workspace that was open when it was created.
        // owner/repo/branch, when given, overrides that remembered workspace —
        // e.g. resuming against a newer workspace for the same task.
        const targetWorkspaceId = hasWorkspaceAddress(input)
          ? await resolveWorkspaceId(env, identity, workspaceAddress(input))
          : task.workspaceId;
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
      forge_start: async (input) => {
        // Create the agent's branch on GitHub before any container exists, so
        // it is real on origin from the moment it exists at all. This is what
        // closes the gap forge_merge's push fallback used to paper over: a
        // branch cut only inside a container that never received a forge_edit
        // never reached origin, and forge_merge's only recourse was a force
        // push that 403'd at the very end of a session. Pass the returned
        // `branch` as `ref` to forge_workspace_create and it adopts this
        // branch instead of cutting a new one.
        const identity = this.identity();
        const owner = text(input.owner);
        const repo = text(input.repo);
        const repository = { provider: 'github' as const, owner, name: repo };
        const request = await githubRequestForWorkspace(env, identity, { repository });

        let baseRef = input.base_ref === undefined ? '' : text(input.base_ref);
        if (!baseRef) {
          const repoInfo = await request(`/repos/${owner}/${repo}`);
          if (repoInfo.status !== 200) {
            throw new ForgeError({
              code: 'FORGE_PROVIDER_UNAVAILABLE',
              message: `GitHub returned HTTP ${repoInfo.status} reading ${owner}/${repo}, so Forge could not resolve its default branch. Pass base_ref explicitly, or check the repository name with forge_access.`,
              retryable: repoInfo.status >= 500
            });
          }
          baseRef = String((repoInfo.json as { default_branch?: string }).default_branch ?? 'main');
        }

        const baseRefRead = await request(
          `/repos/${owner}/${repo}/git/ref/heads/${baseRef.split('/').map(encodeURIComponent).join('/')}`
        );
        if (baseRefRead.status !== 200) {
          throw new ForgeError({
            code: 'FORGE_FILE_NOT_FOUND',
            message: `${baseRef} was not found in ${owner}/${repo} (HTTP ${baseRefRead.status}). Check the branch name, or call forge_branches to list what exists.`,
            retryable: false,
            details: { owner, repo, baseRef }
          });
        }
        const baseSha = (baseRefRead.json as { object?: { sha?: string } }).object?.sha;
        if (!baseSha) {
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: `GitHub returned ${baseRef} on ${owner}/${repo} with no commit sha attached. Try again, or pass a different base_ref.`,
            retryable: true
          });
        }

        // Same digest forge_workspace_create's own branch-cutting fallback
        // uses (scoped by tenant+project, SHA-256, first 16 hex characters),
        // so a slug this mints and one the fallback would have cut look
        // identical in form. An explicit slug is taken as-is; assertForgeBranch
        // below is what actually validates either one.
        const slug = input.slug !== undefined
          ? text(input.slug)
          : await forgeStartSlug({
            tenantId: identity.tenantId,
            projectId: identity.projectId,
            owner,
            repo,
            ...(input.idempotency_key === undefined ? {} : { idempotencyKey: text(input.idempotency_key) })
          });
        const branch = `forge/${slug}`;
        assertForgeBranch(branch);

        const creation = await createBranchRef(request, { owner, repo, branch, baseSha });

        return {
          owner,
          repo,
          branch,
          base_ref: baseRef,
          base_sha: baseSha,
          created: creation.created,
          next_step: `${branch} now exists on GitHub at ${baseSha}. Call forge_workspace_create with this repository and ref:'${branch}' — it will adopt this branch instead of cutting a new one, so it is already on origin when the workspace becomes ready.`
        };
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
        const operationId = `op_${workspaceId.replace(/^ws_/u, '')}` as OperationId;
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
        const initializeWorkspace = coordinator(env, workspaceId).initialize({
            workspaceId,
            operationId,
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
        const quickInitialize = await Promise.race([
          initializeWorkspace.then(
            (value) => ({ status: 'initialized' as const, value }),
            (error) => ({ status: 'failed' as const, error })
          ),
          new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 2_000))
        ]);
        if (quickInitialize.status === 'pending') {
          const finishInitialization = initializeWorkspace.then(async (initialized) => {
            if (!initialized.replay || initialized.state === 'requested') {
              const workflowId = workflowInstanceId('provision', workspaceId);
              try {
                await env.PROVISION_WORKFLOW.create({
                  id: workflowId,
                  params: { workspaceId, bootstrap: Boolean(input.bootstrap) }
                });
              } catch {
                // A retry of workspace_create runs the full existing-instance /
                // terminal-redrive logic below. This continuation only ensures
                // the accepted initialize is followed by a first dispatch.
                await env.PROVISION_WORKFLOW.get(workflowId);
              }
            }
          }).catch(async (error) => {
            await releaseWorkspaceSlot(env.METADATA, workspaceId).catch(() => undefined);
            console.warn('forge_workspace_initialize_failed_after_receipt', {
              workspaceId,
              reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
            });
          });
          (this.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil?.(finishInitialization);
          return {
            workspace_id: workspaceId,
            state: 'requested',
            operation_id: operationId,
            workspace_revision: 1,
            next_step: `Workspace initialization was accepted but its coordinator is busy. Keep workspace_id ${workspaceId} and operation_id ${operationId}; call forge_workspace_get with workspace:'${workspaceId}' once later. Retrying with the same idempotency_key is safe.`
          };
        }
        if (quickInitialize.status === 'failed') {
          // A workspace-ID conflict means an existing live workspace already
          // holds this slot legitimately — releasing it would let the tenant
          // over-admit past its cap. Only release on genuine init failures.
          if (!(quickInitialize.error instanceof ForgeError && quickInitialize.error.code === 'FORGE_WORKSPACE_CONFLICT')) {
            await releaseWorkspaceSlot(env.METADATA, workspaceId);
          }
          throw quickInitialize.error;
        }
        const result = quickInitialize.value;
        // 'suspended' is recoverable (resume), not terminal — keep its slot.
        if (['failed', 'destroyed'].includes(result.state)) {
          await releaseWorkspaceSlot(env.METADATA, workspaceId);
        }
        if (!result.replay || result.state === 'requested') {
          const workflowId = workflowInstanceId('provision', workspaceId);
          const provisionParams = { workspaceId, bootstrap: Boolean(input.bootstrap) };
          const dispatchProvision = async () => {
            try {
              await env.PROVISION_WORKFLOW.create({ id: workflowId, params: provisionParams });
            } catch (createError) {
              let instance;
              try {
                instance = await env.PROVISION_WORKFLOW.get(workflowId);
              } catch {
                // The instance genuinely could not be reached: nothing is
                // driving provisioning, so release the slot and surface the
                // failure if it is immediate. A later failure is still visible
                // to an idempotent retry of workspace_create.
                await releaseWorkspaceSlot(env.METADATA, workspaceId);
                throw createError;
              }
              // .get() succeeds even for a DEAD instance. Re-drive a terminal
              // workflow under a deterministic id so retries remain safe.
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
                  try {
                    await env.PROVISION_WORKFLOW.get(redriveId);
                  } catch {
                    await releaseWorkspaceSlot(env.METADATA, workspaceId);
                    throw redriveError;
                  }
                }
              }
              // Otherwise the existing instance is still running.
            }
          };
          const provisionDispatch = dispatchProvision();
          (this.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil?.(
            provisionDispatch.catch((error) => {
              console.warn('forge_workspace_provision_dispatch_failed', {
                workspaceId,
                reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown'
              });
            })
          );
          // Preserve honest, immediately observable dispatch failures without
          // making the caller wait behind a slow Workflow or Durable Object.
          const quickDispatch = await Promise.race([
            provisionDispatch.then(
              () => ({ failed: false as const }),
              (error) => ({ failed: true as const, error })
            ),
            new Promise<{ failed: false }>((resolve) => setTimeout(() => resolve({ failed: false }), 250))
          ]);
          if (quickDispatch.failed) throw quickDispatch.error;
        }
        // The accepted receipt is the recovery handle. Never poll state here:
        // getState can queue behind provisionInitialized's several-minute DO
        // lock, outliving the host transport and losing both ids.
        const state = result.state;
        if (state === 'ready') {
          (this.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil?.(
            coordinator(env, workspaceId).recordPushAuthProbe().catch(() => undefined)
          );
        }
        // A failed workspace inside a successful tool result is the same lie as
        // an unpushed commit reported as saved: the field says failed, the
        // envelope says it worked, and agents read the envelope. One did exactly
        // that here — took the success, called forge_shell against a dead
        // workspace, met a bare "Workspace is failed.", and decided the GitHub
        // App was read-only. Fail the call, and carry the real reason.
        if (state === 'failed') {
          const failed = await withDeadline(
            coordinator(env, workspaceId).getState({ compact: true }) as unknown as Promise<unknown>,
            1_000
          );
          const failure = failed && typeof failed === 'object' && 'failure' in failed
            ? (failed as { failure?: { stage?: string; code?: string; message?: string } }).failure
            : undefined;
          // Composed outside the message template on purpose: a nested
          // backtick literal in `message:` (this one had one, for the failure
          // detail) defeats invariants.test.ts's static message sweep, which
          // does not parse JS — it would see the fallback stage name
          // ('provision') as if it were the whole message. One flat template
          // with no nested backtick keeps the real message auditable.
          const failureDetail = failure?.message
            ? ` It failed at the ${failure.stage ?? 'provision'} stage: ${failure.message}.`
            : '';
          throw new ForgeError({
            code: 'FORGE_WORKSPACE_NOT_READY',
            message: `Workspace ${workspaceId} could not be provisioned.${failureDetail} This is a provisioning fault, not a repository permission problem — call forge_workspace_create again with the same owner/repo/branch; if it fails a second time, report that rather than working around it.`,
            retryable: true,
            details: {
              workspace_id: workspaceId,
              state,
              operation_id: result.operationId,
              ...(failure?.code ? { failure_code: failure.code } : {}),
              next_step: 'forge_workspace_create'
            }
          });
        }
        const readyState = state === 'ready'
          ? await withDeadline(
              coordinator(env, workspaceId).getState({ compact: true }) as unknown as Promise<unknown>,
              1_000
            )
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
          // `failed` never reaches here — it throws above, so this branch only
          // distinguishes ready from an accepted asynchronous provision.
          next_step: state === 'ready'
            ? `Ready on ${branch || 'forge/…'}. Edit with forge_edit — it commits to GitHub, no push needed. Reuse this workspace_id.`
            : `Provisioning was accepted. Keep workspace_id ${workspaceId} and operation_id ${result.operationId}; call forge_workspace_get with workspace:'${workspaceId}' once later to observe readiness. Retrying this create with the same idempotency_key is safe.`
        };
      },
      forge_workspace_get: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)))).getState({
          compact: Boolean(input.compact)
        }));
      },
      forge_operation_get: async (input) => {
        const identity = this.identity();
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)))).operationGet({
          operationId: text(input.operation_id) as OperationId
        }));
      },
      forge_files_list: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        const containerRoot = toContainerPath(text(input.path));
        const relativeRoot = normalizeRepoPath(text(input.path));
        const depth = number(input.depth);
        const limit = number(input.limit);
        try {
          const { tree } = await resolveBranchTree(env, identity, workspace);
          const { entries, truncated } = listEntriesFromTree(tree, relativeRoot, depth, limit);
          // Tell the model the listing was clipped so it narrows (deeper path,
          // higher limit) instead of assuming it saw the whole tree — or, when
          // GitHub's own tree read was itself incomplete, that narrowing the
          // path is the only thing that will actually help (raising limit
          // will not).
          const hint = truncated
            ? (tree.truncated
                ? 'GitHub could not return this repository\'s whole file tree in one call, so some entries are missing regardless of limit. Narrow with a deeper path.'
                : 'Listing truncated at the limit. Narrow with a deeper path or raise limit.')
            : undefined;
          return asRecord({ root: containerRoot, entries, truncated, source: 'github', ...(hint ? { hint } : {}) });
        } catch (error) {
          if (!(error instanceof GitHubReadUnavailable)) throw error;
          // GitHub itself is unreachable or erroring — fall back to the
          // container's cached tree rather than failing the call outright,
          // but say so: an agent must never mistake a cached answer for an
          // authoritative one.
          const tree = await workspace.filesTree({ path: containerRoot, depth, limit });
          const hint = (tree as { truncated?: boolean }).truncated
            ? 'Listing truncated at the limit. Narrow with a deeper path or raise limit.'
            : undefined;
          // Every entry repeated the same directory prefix — at the default
          // limit of 1000 that is ~16KB of the response saying "/workspace/repo"
          // over and over. State it once. The relative form is what forge_edit
          // reports and what forge_files_read now accepts, so these paths can be
          // passed straight on.
          const prefix = `${containerRoot.replace(/\/+$/u, '')}/`;
          const entries = Array.isArray((tree as { entries?: unknown }).entries)
            ? ((tree as { entries: unknown[] }).entries).map((entry) => {
                const record = entry as { path?: unknown };
                return typeof record.path === 'string' && record.path.startsWith(prefix)
                  ? { ...record, path: record.path.slice(prefix.length) }
                  : record;
              })
            : (tree as { entries?: unknown }).entries;
          return asRecord({
            ...tree,
            root: containerRoot,
            entries,
            source: 'container',
            ...(hint ? { hint } : {}),
            next_step: `GitHub was unreachable (${error.message}), so this listing came from the workspace's cached checkout instead and may be stale relative to GitHub. Retry shortly for the authoritative listing.`
          });
        }
      },
      forge_files_read: async (input) => {
        const identity = this.identity();
        const paths = (
          Array.isArray(input.paths) && input.paths.length > 0
            ? (input.paths as unknown[]).map((value) => text(value))
            : input.path !== undefined
              ? [text(input.path)]
              : []
        ).map((value) => toContainerPath(value));
        if (paths.length === 0) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'Provide either path (one file) or a non-empty paths array (several) — forge_files_read needs at least one to know what to read.',
            retryable: false
          });
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
            message: `This read exceeds the ${MAX_TOTAL_READ_BYTES}-byte aggregate limit (${paths.length} paths x ${perFileMaxBytes} bytes each). Reduce max_bytes, or read fewer paths and call forge_files_read again for the rest.`,
            retryable: false,
            details: { paths: paths.length, maxBytes: perFileMaxBytes, totalLimit: MAX_TOTAL_READ_BYTES }
          });
        }
        const readWorkspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        const workspace = await authorizedCoordinator(env, identity, readWorkspaceId);
        const readOne = {
          startLine: optionalNumber(input.start_line),
          endLine: optionalNumber(input.end_line),
          maxBytes: perFileMaxBytes
        };
        const relativePaths = paths.map((path) => normalizeRepoPath(path));
        // Only a complete read establishes what the agent saw; a range or a
        // truncated read must not license a whole-file overwrite.
        const isCompleteRead = readOne.startLine === undefined && readOne.endLine === undefined;

        // The container fallback, used only when GitHub itself could not be
        // read — never as the primary source. It still re-hashes decoded
        // content for rememberReads, because the container has no tree entry
        // to hand back a real git blob sha from; that is exactly the
        // divergence-on-CRLF/binary risk the GitHub path exists to remove.
        const readFromContainer = async (path: string, reason: string): Promise<Record<string, unknown>> => {
          const one = asRecord(await workspace.filesRead({ path, ...readOne }));
          if (isCompleteRead && typeof one.content === 'string' && !one.truncated) {
            await workspace.rememberReads({
              entries: [{ path: normalizeRepoPath(path), sha: await gitBlobSha(one.content) }]
            });
          }
          return {
            ...readableFile({ ...one, path }),
            source: 'container' as const,
            next_step: `GitHub was unreachable (${reason}), so this came from the workspace's cached checkout instead and may be stale relative to GitHub. Retry shortly for the authoritative read.`
          };
        };

        let treeContext: Awaited<ReturnType<typeof resolveBranchTree>> | undefined;
        let treeUnavailableReason: string | undefined;
        try {
          treeContext = await resolveBranchTree(env, identity, workspace);
        } catch (error) {
          if (!(error instanceof GitHubReadUnavailable)) throw error;
          treeUnavailableReason = error.message;
        }

        const readOnePath = async (containerPath: string, relativePath: string): Promise<Record<string, unknown>> => {
          if (!treeContext) return readFromContainer(containerPath, treeUnavailableReason as string);
          try {
            const result = await readBlobFromTree(
              treeContext.request,
              treeContext.repository.owner,
              treeContext.repository.name,
              treeContext.tree,
              relativePath,
              readOne
            );
            if (isCompleteRead) {
              // The blob sha GitHub just reported for this exact path — not a
              // re-hash of decoded content, which is what this whole change
              // exists to stop being wrong on CRLF and binary files.
              await workspace.rememberReads({ entries: [{ path: relativePath, sha: result.blobSha }] });
            }
            return { path: relativePath, content: result.content, sizeBytes: result.sizeBytes, truncated: result.truncated, source: 'github' as const };
          } catch (error) {
            if (error instanceof GitHubReadUnavailable) return readFromContainer(containerPath, error.message);
            throw error;
          }
        };

        // Single path keeps the original flat shape; multiple returns a files
        // array with per-file errors so one missing file does not fail the batch.
        if (paths.length === 1) {
          return readOnePath(paths[0] as string, relativePaths[0] as string);
        }
        const files = await Promise.all(
          paths.map(async (path, index) => {
            try {
              return await readOnePath(path, relativePaths[index] as string);
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
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
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
        const requested = (input.files as Array<{ path: string; content?: string | null; replace?: Array<{ old: string; new: string; all?: boolean }> }>).map((file) => ({
          path: normalizeRepoPath(text(file.path)),
          content: file.content === undefined ? undefined : file.content === null ? null : text(file.content),
          replace: file.replace
        }));
        for (const file of requested) {
          const hasContent = file.content !== undefined;
          const hasReplace = Array.isArray(file.replace) && file.replace.length > 0;
          if (hasContent === hasReplace) {
            throw new ForgeError({
              code: 'FORGE_VALIDATION_FAILED',
              message: `${file.path}: send either content (whole file, or null to delete) or replace (fragments), not both and not neither.`,
              retryable: false
            });
          }
        }
        const duplicate = requested.map((f) => f.path).find((path, index, all) => all.indexOf(path) !== index);
        if (duplicate) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `"${duplicate}" appears twice in one edit. Send each path once — the last write would silently win.`,
            retryable: false
          });
        }
        const message = input.message === undefined
          ? `edit: ${requested.length} file${requested.length === 1 ? '' : 's'}`
          : text(input.message);
        const editIdempotencyKey = input.idempotency_key === undefined
          ? undefined
          : text(input.idempotency_key);
        const editIntentHash = editIdempotencyKey
          ? await sha256(JSON.stringify({ requested, message }))
          : undefined;
        if (editIdempotencyKey && editIntentHash) {
          const replay = await workspace.remoteMutationReplay({
            kind: 'edit',
            idempotencyKey: editIdempotencyKey,
            intentHash: editIntentHash
          });
          if (replay && typeof replay === 'object') return { ...(replay as Record<string, unknown>), replayed: true };
        }

        const request = await githubRequestForWorkspace(env, identity, { repository: state.repository });
        // Fragment edits are resolved here, against what the file actually
        // contains right now. Forge does the reading, so the agent never has
        // to re-emit a whole file and cannot lose the parts it did not send.
        const resolvedBlobs: Record<string, string> = {};
        const files: Array<{ path: string; content: string | null }> = [];
        for (const file of requested) {
          if (file.content !== undefined) {
            files.push({ path: file.path, content: file.content });
            continue;
          }
          const source = await readFragmentSource(request, {
            base: `/repos/${state.repository.owner}/${state.repository.name}`,
            branch,
            baseSha: state.baseCommit ?? state.currentCommit,
            path: file.path
          });
          if (!source.ok) {
            if (source.kind === 'base_unavailable') {
              throw new ForgeError({
                code: 'FORGE_WORKSPACE_NOT_READY',
                message: `${branch} is not on GitHub yet and the workspace has no base commit recorded, so Forge cannot safely resolve ${file.path}. Nothing was written; retry after the workspace is ready.`,
                retryable: true,
                details: { path: file.path, branch, cause: 'branch_absent_no_base' }
              });
            }
            if (source.kind === 'file_missing') {
              const missingFrom = source.branchMissing
                ? `base commit ${source.sourceRef}`
                : branch;
              throw new ForgeError({
                code: 'FORGE_FILE_NOT_FOUND',
                message: `${file.path} cannot be fragment-edited because it does not exist on ${missingFrom}. Use whole-file content to create it instead.`,
                retryable: false,
                details: { path: file.path, branch, sourceRef: source.sourceRef, cause: source.branchMissing ? 'file_absent_at_base' : 'file_absent' }
              });
            }
            const transient = source.status === 429 || source.status >= 500;
            throw new ForgeError({
              code: transient ? 'FORGE_PROVIDER_UNAVAILABLE' : 'FORGE_PERMISSION_DENIED',
              message: transient
                ? `GitHub returned HTTP ${source.status} resolving ${file.path} from ${source.sourceRef}, which is a transient fault rather than anything about the file. Retry the same edit.`
                : `GitHub returned HTTP ${source.status} resolving ${file.path} from ${source.sourceRef}. This is an access problem, not a missing file — call forge_access for this repository, and do not send whole-file content, which would overwrite what is really there.`,
              retryable: transient,
              details: { path: file.path, branch, status: source.status, operation: source.operation }
            });
          }
          const body = source.body;
          if (typeof body.content !== 'string' || typeof body.sha !== 'string') {
            throw new ForgeError({
              code: 'FORGE_FILE_CONFLICT',
              message: `${file.path} could not be read as text, so fragment replacement cannot be applied to it.`,
              retryable: false,
              details: { path: file.path }
            });
          }
          const currentText = new TextDecoder().decode(
            Uint8Array.from(atob(body.content.replace(/\n/gu, '')), (character) => character.charCodeAt(0))
          );
          try {
            files.push({ path: file.path, content: applyReplacements(file.path, currentText, file.replace!) });
          } catch (error) {
            if (error instanceof ReplacementFailed) {
              throw new ForgeError({
                code: 'FORGE_FILE_CONFLICT',
                message: error.message,
                retryable: false,
                details: { path: error.path, reason: error.reason }
              });
            }
            throw error;
          }
          // Forge read it, so the read-before-overwrite guard is satisfied by
          // the blob it actually applied the change to.
          resolvedBlobs[file.path] = body.sha;
        }
        let result;
        try {
          result = await commitFilesToBranch(request, {
            owner: state.repository.owner,
            repo: state.repository.name,
            branch,
            message,
            files,
            expectedBlobs: { ...(await workspace.seenBlobs({ paths: files.map((file) => file.path) })), ...resolvedBlobs },
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
          pushVerified: result.pushVerified,
          remoteSha: result.remoteSha,
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

        const receipt = {
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
        if (editIdempotencyKey && editIntentHash) {
          await workspace.recordRemoteMutation({
            kind: 'edit',
            idempotencyKey: editIdempotencyKey,
            intentHash: editIntentHash,
            receipt
          }).catch(() => undefined);
        }
        return receipt;
      },
      forge_diff_metadata: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        const base = text(input.base);
        const outgoing = await workspace.gitOutgoingDiff({ base: await outgoingComparisonRef(workspace, base), maxBytes: 256_000 });
        const compact = analyzeDiff(outgoing.diff);
        return asRecord(compact);
      },
      forge_context_get: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
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
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
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
        // A host kills the request long before Forge's own timeout fires:
        // timeout_ms defaults to 300s while ChatGPT and Claude cut the
        // transport at around 60. Anything slower than that returned no
        // process id, no output and no handle — while the command kept
        // running — which is the worst shape a failure can have. Route it
        // through the managed-process path instead, so a long command always
        // comes back as something the agent can wait on.
        const HOST_SAFE_SYNC_MS = 30_000;
        const CHECKOUT_SYNC_DEADLINE_MS = 10_000;
        const requestedTimeout = number(input.timeout_ms);
        const escalated = input.async !== true
          && input.mode !== 'read_only'
          && Number.isFinite(requestedTimeout)
          && requestedTimeout > HOST_SAFE_SYNC_MS;
        try {
          const normalizedCwd = cwd.replace(/\/+$/u, '') || '/workspace';
          const repoScoped = normalizedCwd === '/workspace/repo' || normalizedCwd.startsWith('/workspace/repo/');
          if (repoScoped) {
            // Both foreground and managed commands must start from the remote
            // branch they claim to verify. Time-box the prerequisite so a busy
            // coordinator cannot consume the whole client transport before an
            // async command has returned its process handle.
            const synced = await withDeadline(workspace.syncToRemoteHead(), CHECKOUT_SYNC_DEADLINE_MS);
            if (!synced?.synced) {
              if (synced?.blockedByLocalChanges) {
                throw new ForgeError({
                  code: 'FORGE_GIT_DIRTY',
                  message: 'Forge found uncommitted container writes and refused to reset over them before running this command. The files are preserved. Re-apply or commit them with forge_edit, then retry forge_shell.',
                  retryable: false,
                  details: { cwd, preserved: true, allowedNextActions: ['forge_edit', 'forge_workspace_get'] }
                });
              }
              throw new ForgeError({
                code: 'FORGE_GIT_FETCH_FAILED',
                message: 'Forge could not prove that the repository checkout matches the GitHub branch before running this command, so nothing ran. Retry forge_shell after checking forge_workspace_get; commands outside /workspace/repo are unaffected.',
                retryable: true,
                details: { cwd, syncDeadlineMs: CHECKOUT_SYNC_DEADLINE_MS, allowedNextActions: ['forge_workspace_get', 'forge_shell'] }
              });
            }
          }
          if (input.async === true || escalated) {
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
              allowedNextActions: ['forge_process_wait', 'forge_process_logs', 'forge_process_list'],
              ...(escalated && input.async !== true
                ? {
                    escalated_to_background: true,
                    escalated_reason: `timeout_ms ${requestedTimeout}ms exceeds the ${HOST_SAFE_SYNC_MS}ms a client will hold a request open, so this runs as a managed process instead of failing the transport.`
                  }
                : {}),
              next_step: `Running in the background as ${processId}. Call forge_process_wait with that process_id; each call observes for at most 30000ms, or use forge_process_logs to inspect output. Do not re-run the command.`
            };
          }
          const result = await workspace.shellExec({
            command,
            cwd,
            timeoutMs: Math.min(number(input.timeout_ms), input.mode === 'read_only' ? 35_000 : HOST_SAFE_SYNC_MS),
            environment,
            networkPolicy,
            outputLimitBytes: number(input.output_limit_bytes),
            expectedRevision: optionalNumber(input.expected_revision),
            idempotencyKey: idempotency(input.idempotency_key),
            approved: claimedApproval,
            mode: input.mode === 'read_only' || input.mode === 'mutating' ? input.mode : undefined
          });
          if (claimedApproval && approvalId) await completeApproval(env, approvalId, true, { reusable: true });
          // Colour codes are 40% of a real test-run response and mean nothing
          // to a reader that is not a terminal: one `[31m` is ten JSON
          // characters the agent cannot act on. Stripping here — before
          // redaction, the summariser, the tails and the artifact spill — also
          // makes the tail budget carry ~2.4x more actual output, which is the
          // difference between seeing the failing assertion and seeing the
          // escape codes around it. Redaction runs on clean text too, so a
          // secret printed with colour in the middle still matches.
          let stdout = stripAnsi('stdout' in result ? String(result.stdout ?? '') : '');
          let stderr = stripAnsi('stderr' in result ? String(result.stderr ?? '') : '');
          if (attached.redact.size > 0) {
            stdout = await vaultService(env).redactOutput(stdout, identity.tenantId as TenantId, workspaceId);
            stderr = await vaultService(env).redactOutput(stderr, identity.tenantId as TenantId, workspaceId);
          }
          const exitCode = 'exitCode' in result ? Number(result.exitCode) : undefined;
          const compact = input.compact !== false;
          // Replace the log with the answer when the command's output has a
          // known shape. A 300KB test run becomes a headline plus the failing
          // test names — the difference between a session that can run tests,
          // read failures, fix and re-run, and one that dies on the first run.
          // The full log is still spilled to an artifact below.
          const summary = summariseCommandOutput({ command, output: `${stdout}\n${stderr}`, exitCode });
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
          // Anything this command wrote lives only in the container, which is
          // the one place that is not durable. Commit it before returning, so
          // a formatter or codemod cannot leave work to be lost at the next
          // sync — and so the agent is never holding changes it must remember
          // to save.
          let ingested: { committed: boolean; commit_sha?: string; paths: string[]; truncated: boolean; failed?: boolean };
          if (input.mode === 'read_only') {
            ingested = { committed: false, paths: [], truncated: false };
          } else {
            const ingestion = this.ingestContainerWrites(env, identity, workspaceId, workspace, `${command.slice(0, 80)}`);
            (this.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil?.(
              ingestion.catch(() => undefined)
            );
            ingested = await withDeadline(ingestion, 10_000)
              ?? { committed: false, paths: [], truncated: false, failed: true };
          }
          const wrote = ingested.paths.length || ingested.failed || ingested.truncated
            ? {
                ...(ingested.paths.length ? { committed_files: ingested.paths } : {}),
                ...('commit_sha' in ingested && ingested.commit_sha ? { commit_sha: ingested.commit_sha } : {}),
                ...(ingested.failed || ingested.truncated
                  ? { committed_files_warning: ingested.truncated
                      ? 'Forge found too many changed files, truncated status output, or a changed file over the ingestion limit. It published none of this incomplete set and preserved every container write; publish the wanted files with forge_edit before another repo-scoped shell command.'
                      : 'Forge could not confirm this command’s repository writes on GitHub within the request. The container is preserved; use forge_edit to publish wanted changes before another repo-scoped shell command.' }
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
              ...(summary ? { result_summary: summary } : {}),
              // With a summary the tails are noise; without one they are the
              // only thing the agent has.
              stdout_tail: tailBytes(stdout, summary ? 800 : AGENT_OUTPUT_TAIL_BYTES),
              stderr_tail: tailBytes(stderr, summary ? 800 : AGENT_OUTPUT_TAIL_BYTES),
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
        return asRecord(await (await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)))).processLogs({
          processId: text(input.process_id) as ProcessId,
          cursor: input.cursor ? text(input.cursor) : undefined
        }));
      },
      forge_process_list: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        if (input.process_id) {
          return asRecord(await workspace.processGet({ processId: text(input.process_id) as ProcessId }));
        }
        return asRecord(await workspace.processList());
      },
      forge_process_stop: async (input) => {
        const identity = this.identity();
        const workspace = await authorizedCoordinator(env, identity, await resolveWorkspaceId(env, identity, workspaceAddress(input)));
        const args = {
          processId: text(input.process_id) as ProcessId,
          expectedRevision: optionalNumber(input.expected_revision),
          idempotencyKey: idempotency(input.idempotency_key)
        };
        return asRecord(input.force ? await workspace.processCancel(args) : await workspace.processStop(args));
      },
      forge_process_wait: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        const workspace = await authorizedCoordinator(env, identity, workspaceId);
        const waited = asRecord(await workspace.processWait({
          processId: text(input.process_id) as ProcessId,
          timeoutMs: Math.min(optionalNumber(input.timeout_ms) ?? 30_000, 30_000)
        }));
        if (waited.timedOut === true) return waited;

        const process = waited.process && typeof waited.process === 'object'
          ? waited.process as Record<string, unknown>
          : {};
        const mutatesFilesystem = process.mutatesFilesystem === true;
        const exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined;
        if (!mutatesFilesystem) {
          return {
            ...waited,
            remote_persisted: true,
            next_step: 'Process finished without repository mutations. Continue with forge_shell or forge_workspace_get.'
          };
        }
        if (exitCode !== 0) {
          return {
            ...waited,
            remote_persisted: false,
            committed_files_warning: 'The mutating process did not exit successfully, so Forge did not publish its partial container writes to GitHub. Inspect the logs and re-apply any wanted changes with forge_edit.',
            next_step: 'Inspect forge_process_logs. Any partial repository writes remain only in the preserved container until you re-apply them with forge_edit.'
          };
        }

        // Application finalization proves provider visibility and may create a
        // recovery checkpoint; neither is a remote commit. Reconcile through
        // the same GitHub commit path foreground forge_shell uses before this
        // successful mutation is described as durable.
        const ingestion = this.ingestContainerWrites(
          env,
          identity,
          workspaceId,
          workspace,
          `${String(process.command ?? 'background command').slice(0, 80)}`
        );
        (this.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil?.(
          ingestion.catch(() => undefined)
        );
        const ingested = await withDeadline(ingestion, 10_000);
        const remotePersisted = Boolean(
          ingested &&
          !ingested.truncated &&
          (ingested.committed || ingested.paths.length === 0)
        );
        return {
          ...waited,
          remote_persisted: remotePersisted,
          ...(ingested?.paths.length ? { committed_files: ingested.paths } : {}),
          ...(ingested?.commit_sha ? { commit_sha: ingested.commit_sha } : {}),
          ...(!remotePersisted
            ? {
                committed_files_warning: ingested?.truncated
                  ? 'The process succeeded, but the changed-file set was too large to ingest completely. Forge published none of the incomplete set and preserved every container write; publish the wanted files with forge_edit.'
                  : 'The process succeeded, but Forge could not confirm its repository writes on GitHub within this request. The container writes are preserved; call forge_process_wait again with the same process_id to retry reconciliation.',
                next_step: ingested?.truncated
                  ? 'Use forge_edit to publish the wanted preserved files. Do not re-run the command or start another repo-scoped shell command first.'
                  : 'Call forge_process_wait again with the same process_id. Do not re-run the command; Forge will retry publishing its preserved writes.'
              }
            : {
                next_step: ingested?.commit_sha
                  ? `Process finished and its repository writes were committed to GitHub as ${ingested.commit_sha}. Continue with forge_shell or forge_workspace_get.`
                  : 'Process finished and Forge confirmed there were no repository writes to publish. Continue with forge_shell or forge_workspace_get.'
              })
        };
      },
      forge_deps_install: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
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
      forge_pr: async (input) => {
        const identity = this.identity();
        const owner = text(input.owner);
        const repo = text(input.repo);
        const request = await githubRequestForWorkspace(env, identity, { repository: { provider: 'github' as const, owner, name: repo } });
        const base = `/repos/${owner}/${repo}`;

        if (input.action === undefined || input.action === 'list') {
          const listed = await request(`${base}/pulls?state=open&per_page=50`);
          if (listed.status !== 200) {
            throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: `GitHub returned HTTP ${listed.status} listing pull requests.`, retryable: true });
          }
          const pulls = (listed.json as Array<{ number: number; title: string; head: { ref: string }; base: { ref: string }; draft?: boolean; html_url: string }>).map((pr) => ({
            number: pr.number, title: pr.title, head: pr.head.ref, base: pr.base.ref, draft: pr.draft === true, url: pr.html_url
          }));
          return {
            repository: `${owner}/${repo}`,
            pull_requests: pulls,
            next_step: pulls.length
              ? `${pulls.length} open. Call action:'status' with a number before merging — it reports whether merging is actually safe.`
              : 'No open pull requests.'
          };
        }

        const number = input.number === undefined ? undefined : Number(input.number);
        if (!number) {
          throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `action:'${text(input.action)}' needs a pull request number. Call action:'list' first.`, retryable: false });
        }

        // Always read fresh. A status an agent read earlier describes the head
        // it saw then; merging on it would merge commits nobody assessed.
        const readStatus = async () => {
          try {
            return await readPullRequestReadiness(request, base, number);
          } catch (error) {
            throw new ForgeError({
              code: 'FORGE_PROVIDER_UNAVAILABLE',
              message: error instanceof Error ? error.message : `GitHub could not read pull request #${number}.`,
              retryable: true,
              details: { owner, repo, number }
            });
          }
        };

        if (input.action === 'status') {
          const status = await readStatus();
          const { merge_commit_sha: _mergeCommitSha, ...publicStatus } = status;
          return {
            repository: `${owner}/${repo}`,
            status: publicStatus,
            next_step: status.safe_to_merge
              ? `#${number} is safe to merge at ${status.head_sha.slice(0, 12)}. Ask the human, then action:'merge'.`
              : `#${number} is NOT safe to merge: ${status.blockers.join(' ')}`
          };
        }

        if (input.action === 'close') {
          const status = await readStatus();
          if (input.expected_head_sha !== undefined && text(input.expected_head_sha) !== status.head_sha) {
            throw new ForgeError({
              code: 'FORGE_WORKSPACE_CONFLICT',
              message: `Pull request #${number} moved to ${status.head_sha}, so Forge refused to close the head ${text(input.expected_head_sha)} you assessed. Read status again, then retry with the new expected_head_sha.`,
              retryable: false,
              details: { number, expected_head_sha: text(input.expected_head_sha), current_head_sha: status.head_sha }
            });
          }
          if (status.state === 'closed' || status.already_merged) {
            return { repository: `${owner}/${repo}`, closed: true, next_step: `Pull request #${number} is already closed; this retry changed nothing.` };
          }
          const mutationScope = `forge_pr:${owner.toLowerCase()}/${repo.toLowerCase()}`;
          const mutationKey = input.idempotency_key === undefined ? undefined : text(input.idempotency_key);
          const mutationIntentHash = mutationKey
            ? await sha256(JSON.stringify({ action: 'close', owner: owner.toLowerCase(), repo: repo.toLowerCase(), number, head: status.head_sha }))
            : undefined;
          if (mutationKey && mutationIntentHash) {
            const replay = await readExternalMutationReceipt(env, { tenantId: identity.tenantId, scope: mutationScope, idempotencyKey: mutationKey, intentHash: mutationIntentHash });
            if (replay) return { ...replay, replayed: true };
          }
          const approvalPayload = { action: 'close', owner, repo, number, headSha: status.head_sha };
          let approvalId = input.approval_id === undefined ? undefined : text(input.approval_id);
          const approvalWorkspace = `repository:${owner.toLowerCase()}/${repo.toLowerCase()}`;
          if (!approvalId) {
            const approval = await requestApproval(env, identity, approvalWorkspace, 'pull_request.mutate', `Close pull request #${number}`, approvalPayload);
            if (approval.already_approved) approvalId = approval.approval_id;
            else {
              const inline = await this.tryResolveApprovalInline(identity, approval, `Close pull request #${number}`);
              if (!inline) {
                throw new ForgeError({
                  code: 'FORGE_APPROVAL_REQUIRED',
                  message: `Closing pull request #${number} needs human approval. Open the approval URL, approve, then retry with approval_id and the same idempotency_key.`,
                  retryable: false,
                  details: { kind: 'approval', action: 'pull_request.mutate', ...approval }
                });
              }
              approvalId = inline;
            }
          }
          await requireApproval(env, identity, approvalId, approvalWorkspace, 'pull_request.mutate', approvalPayload, { consume: false });
          const claim = mutationKey && mutationIntentHash
            ? await claimExternalMutation(env, { tenantId: identity.tenantId, scope: mutationScope, idempotencyKey: mutationKey, intentHash: mutationIntentHash })
            : undefined;
          if (claim?.kind === 'replay') return { ...claim.receipt, replayed: true };
          await requireApproval(env, identity, approvalId, approvalWorkspace, 'pull_request.mutate', approvalPayload);
          try {
            const closed = await request(`${base}/pulls/${number}`, { method: 'PATCH', body: { state: 'closed' } });
            if (closed.status !== 200) {
              throw new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message: `GitHub returned HTTP ${closed.status} closing #${number}; retry the same call because Forge did not receive a closing receipt.`, retryable: true });
            }
            const receipt = { repository: `${owner}/${repo}`, closed: true, next_step: `Closed #${number} without merging.` };
            if (mutationKey && claim?.kind === 'claimed') {
              await recordExternalMutationReceipt(env, { tenantId: identity.tenantId, scope: mutationScope, idempotencyKey: mutationKey, ownerToken: claim.ownerToken, receipt });
            }
            await completeApproval(env, approvalId, true);
            return receipt;
          } catch (error) {
            await completeApproval(env, approvalId, false).catch(() => undefined);
            throw error;
          }
        }

        const status = await readStatus();
        if (status.already_merged) {
          return {
            repository: `${owner}/${repo}`,
            merged: true,
            merge_sha: status.merge_commit_sha ?? '',
            next_step: `Pull request #${number} is already merged; this retry changed nothing.`
          };
        }
        if (input.expected_head_sha !== undefined && text(input.expected_head_sha) !== status.head_sha) {
          throw new ForgeError({
            code: 'FORGE_WORKSPACE_CONFLICT',
            message: `Pull request #${number} moved to ${status.head_sha}, so Forge refused to merge the head ${text(input.expected_head_sha)} you assessed. Read status again, then retry with the new expected_head_sha.`,
            retryable: false,
            details: { number, expected_head_sha: text(input.expected_head_sha), current_head_sha: status.head_sha }
          });
        }
        if (!status.safe_to_merge && input.force !== true) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `#${number} is not safe to merge: ${status.blockers.join(' ')} Nothing was merged. Fix these, or pass force:true with a reason to merge anyway.`,
            retryable: false,
            details: { number, blockers: status.blockers, head_sha: status.head_sha }
          });
        }
        if (!status.safe_to_merge && !input.reason) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'force:true requires a reason, so the record says why a pull request was merged past its own blockers.',
            retryable: false,
            details: { number, blockers: status.blockers }
          });
        }
        const mergeMethod = input.merge_method === undefined ? 'merge' : text(input.merge_method);
        const mutationScope = `forge_pr:${owner.toLowerCase()}/${repo.toLowerCase()}`;
        const mutationKey = input.idempotency_key === undefined ? undefined : text(input.idempotency_key);
        const mutationIntentHash = mutationKey
          ? await sha256(JSON.stringify({ action: 'merge', owner: owner.toLowerCase(), repo: repo.toLowerCase(), number, head: status.head_sha, mergeMethod, force: input.force === true, reason: input.reason === undefined ? null : text(input.reason) }))
          : undefined;
        if (mutationKey && mutationIntentHash) {
          const replay = await readExternalMutationReceipt(env, { tenantId: identity.tenantId, scope: mutationScope, idempotencyKey: mutationKey, intentHash: mutationIntentHash });
          if (replay) return { ...replay, replayed: true };
        }
        const approvalPayload = {
          action: 'merge', owner, repo, number, headSha: status.head_sha, mergeMethod,
          force: input.force === true,
          reason: input.reason === undefined ? null : text(input.reason)
        };
        let approvalId = input.approval_id === undefined ? undefined : text(input.approval_id);
        const approvalWorkspace = `repository:${owner.toLowerCase()}/${repo.toLowerCase()}`;
        if (!approvalId) {
          const approval = await requestApproval(env, identity, approvalWorkspace, 'pull_request.mutate', `Merge pull request #${number}`, approvalPayload);
          if (approval.already_approved) approvalId = approval.approval_id;
          else {
            const inline = await this.tryResolveApprovalInline(identity, approval, `Merge pull request #${number}`);
            if (!inline) {
              throw new ForgeError({
                code: 'FORGE_APPROVAL_REQUIRED',
                message: `Merging pull request #${number} needs human approval. Open the approval URL, approve, then retry with approval_id and the same idempotency_key.`,
                retryable: false,
                details: { kind: 'approval', action: 'pull_request.mutate', ...approval }
              });
            }
            approvalId = inline;
          }
        }
        await requireApproval(env, identity, approvalId, approvalWorkspace, 'pull_request.mutate', approvalPayload, { consume: false });
        const claim = mutationKey && mutationIntentHash
          ? await claimExternalMutation(env, { tenantId: identity.tenantId, scope: mutationScope, idempotencyKey: mutationKey, intentHash: mutationIntentHash })
          : undefined;
        if (claim?.kind === 'replay') return { ...claim.receipt, replayed: true };
        await requireApproval(env, identity, approvalId, approvalWorkspace, 'pull_request.mutate', approvalPayload);
        try {
          const merged = await request(`${base}/pulls/${number}/merge`, {
            method: 'PUT',
            body: { merge_method: mergeMethod, sha: status.head_sha }
          });
          if (merged.status !== 200) {
            throw new ForgeError({
              code: 'FORGE_PROVIDER_UNAVAILABLE',
              message: `GitHub refused the merge of #${number} with HTTP ${merged.status}; retry the same call because Forge did not receive a merge receipt.`,
              retryable: merged.status >= 500,
              details: { number, head_sha: status.head_sha }
            });
          }
          const receipt = {
            repository: `${owner}/${repo}`,
            merged: true,
            merge_sha: String((merged.json as { sha?: string }).sha ?? ''),
            next_step: `Merged #${number}. Delete the branch with forge_branches if it is no longer needed.`
          };
          if (mutationKey && claim?.kind === 'claimed') {
            await recordExternalMutationReceipt(env, { tenantId: identity.tenantId, scope: mutationScope, idempotencyKey: mutationKey, ownerToken: claim.ownerToken, receipt });
          }
          await completeApproval(env, approvalId, true);
          return receipt;
        } catch (error) {
          await completeApproval(env, approvalId, false).catch(() => undefined);
          throw error;
        }
      },
      forge_access: async (input) => {
        const identity = this.identity();
        const rows = await listAuthorizedRepositories(env, identity.tenantId);
        const authorized = rows.map((row) => `${String(row.owner)}/${String(row.name)}`);
        if (input.owner === undefined || input.repo === undefined) {
          return {
            authorized_repositories: authorized,
            next_step: authorized.length
              ? `Forge can reach ${authorized.length} repositor(y/ies). Pass owner and repo to check one specifically.`
              : 'No repositories are authorized. Install the Forge GitHub App and grant it the repositories you want.'
          };
        }
        const owner = text(input.owner);
        const repo = text(input.repo);
        const checked = `${owner}/${repo}`;
        if (!authorized.some((entry) => entry.toLowerCase() === checked.toLowerCase())) {
          return {
            authorized_repositories: authorized,
            checked,
            authorized: false,
            can_read: false,
            can_write: false,
            reason: `${checked} is not in this account's authorized repositories.`,
            next_step: `Install or grant the Forge GitHub App access to ${checked}. This is an installation problem, not a Git transport problem — retrying a push will not fix it.`
          };
        }
        // Authorized in Forge's records is not the same as reachable now, so
        // prove it against GitHub rather than reporting the row.
        const request = await githubRequestForWorkspace(env, identity, { repository: { provider: 'github' as const, owner, name: repo } }).catch(() => undefined);
        if (!request) {
          return { authorized_repositories: authorized, checked, authorized: true, can_read: false, can_write: false, reason: 'Forge could not mint an installation token for this repository.', next_step: `Re-install the Forge GitHub App for ${checked}.` };
        }
        const info = await request(`/repos/${owner}/${repo}`);
        // Write capability comes from the permissions GitHub grants the token,
        // never from the repository object: fetched with an installation token
        // it carries no `permissions` field at all, so reading `permissions.push`
        // reported can_write:false for every repository regardless of the truth.
        // That is what sent agents troubleshooting a permission problem that did
        // not exist, and told users to grant access they had already granted.
        const proof = await repositoryWriteProof(env, identity, { provider: 'github' as const, owner, name: repo });
        const canWrite = proof.authorized === true && proof.can_write;
        const canRead = info.status === 200;
        return {
          authorized_repositories: authorized,
          checked,
          authorized: true,
          can_read: canRead,
          can_write: canWrite,
          ...(proof.authorized === true && Object.keys(proof.permissions).length > 0
            ? { granted_permissions: proof.permissions }
            : {}),
          ...(canRead ? { default_branch: String((info.json as { default_branch?: string }).default_branch ?? 'main') } : {}),
          ...(canRead
            ? proof.authorized === true && proof.reason
              ? { reason: proof.reason }
              : {}
            : { reason: `GitHub returned HTTP ${info.status} for ${checked}.` }),
          next_step: !canRead
            ? `Forge cannot read ${checked} (HTTP ${info.status}). Check the App installation before assuming a transport fault.`
            : canWrite
              ? `Forge can read and write ${checked}. A failed edit, push or merge here is NOT a permission problem — read that tool's own error instead of re-checking access.`
              : `Forge can read ${checked} but GitHub refused a write-scoped token. Grant the Forge GitHub App contents:write on ${checked}.`
        };
      },
      forge_history: async (input) => {
        const identity = this.identity();
        const owner = text(input.owner);
        const repo = text(input.repo);
        const request = await githubRequestForWorkspace(env, identity, { repository: { provider: 'github' as const, owner, name: repo } });
        const limit = input.limit === undefined ? 20 : Number(input.limit);
        const query = new URLSearchParams({ per_page: String(Math.min(Math.max(limit, 1), 50)) });
        if (input.ref !== undefined) query.set('sha', text(input.ref));
        if (input.path !== undefined) query.set('path', normalizeRepoPath(text(input.path)));
        const listed = await request(`/repos/${owner}/${repo}/commits?${query.toString()}`);
        if (listed.status !== 200) {
          throw new ForgeError({
            code: listed.status === 404 ? 'FORGE_FILE_NOT_FOUND' : 'FORGE_PROVIDER_UNAVAILABLE',
            message: input.path === undefined
              ? `GitHub returned HTTP ${listed.status} reading history for ${owner}/${repo}.`
              : `No history for ${text(input.path)} on ${input.ref === undefined ? 'the default branch' : text(input.ref)} (HTTP ${listed.status}). Check the path.`,
            retryable: listed.status >= 500
          });
        }
        const commits = (listed.json as Array<{ sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } } }>).map((entry) => ({
          sha: entry.sha,
          message: entry.commit.message.split('\n')[0] ?? '',
          author: entry.commit.author?.name ?? 'unknown',
          date: entry.commit.author?.date ?? '',
          url: entry.html_url
        }));
        return {
          repository: `${owner}/${repo}`,
          ref: input.ref === undefined ? 'default' : text(input.ref),
          ...(input.path === undefined ? {} : { path: normalizeRepoPath(text(input.path)) }),
          commits,
          returned: commits.length,
          next_step: commits.length
            ? `${commits.length} commit(s). Read any file at a commit with forge_files_read, or open a URL above.`
            : 'No commits matched.'
        };
      },
      forge_branches: async (input) => {
        const identity = this.identity();
        const owner = text(input.owner);
        const repo = text(input.repo);
        const repository = { provider: 'github' as const, owner, name: repo };
        const request = await githubRequestForWorkspace(env, identity, { repository });
        const base = `/repos/${owner}/${repo}`;
        const branchToolDeadline = Date.now() + 45_000;

        const repoInfo = await request(base);
        if (repoInfo.status !== 200) {
          throw new ForgeError({
            code: 'FORGE_PERMISSION_DENIED',
            message: `Forge cannot read ${owner}/${repo}. Install and authorize the Forge GitHub App for it.`,
            retryable: false
          });
        }
        const defaultBranch = String((repoInfo.json as { default_branch?: string }).default_branch ?? 'main');

        let raw;
        let paginationTruncated = false;
        try {
          const listed = await listGitHubBranchesWithinBudget(request, base, Math.min(branchToolDeadline, Date.now() + 10_000));
          raw = listed.branches;
          paginationTruncated = listed.truncated;
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'GitHub returned an unreadable branch-list response';
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: `Forge could not list branches for ${owner}/${repo} because ${reason}. Retry the same call; no branch was changed.`,
            retryable: true
          });
        }

        // "Merged" is decided by asking GitHub whether the default branch
        // already contains the tip, never by the branch's name or age. A
        // deletion that guessed would be unrecoverable.
        const comparisonDeadline = branchToolDeadline;
        const branchCandidates = input.action === 'delete' && input.merged_only !== true && input.branch !== undefined
          ? raw.filter((entry) => entry.name === defaultBranch || entry.name === text(input.branch))
          : raw;
        const branches: Array<{ name: string; sha: string; merged: boolean; is_default: boolean; protected: boolean }> = [];
        let comparisonTruncated = paginationTruncated;
        for (let offset = 0; offset < branchCandidates.length; offset += 8) {
          if (Date.now() >= comparisonDeadline) {
            comparisonTruncated = true;
            break;
          }
          const batch = branchCandidates.slice(offset, offset + 8);
          const comparedBatch = await Promise.all(batch.map(async (entry) => {
            const isDefault = entry.name === defaultBranch;
            if (isDefault) return { name: entry.name, sha: entry.commit.sha, merged: true, is_default: true, protected: entry.protected === true };
            const compared = await withDeadline(
              request(`${base}/compare/${encodeURIComponent(defaultBranch)}...${entry.name.split('/').map(encodeURIComponent).join('/')}`),
              Math.max(250, Math.min(5_000, comparisonDeadline - Date.now()))
            );
            if (!compared || compared.status !== 200) return undefined;
            const status = (compared.json as { status?: string }).status;
            // behind or identical => everything on it is already in default.
            return {
              name: entry.name,
              sha: entry.commit.sha,
              merged: status === 'behind' || status === 'identical',
              is_default: false,
              protected: entry.protected === true
            };
          }));
          branches.push(...comparedBatch.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined));
          if (comparedBatch.some((entry) => entry === undefined)) comparisonTruncated = true;
        }
        if (branches.length < branchCandidates.length) comparisonTruncated = true;

        if (input.action !== 'delete') {
          const mergedCount = branches.filter((entry) => entry.merged && !entry.is_default).length;
          return {
            repository: `${owner}/${repo}`,
            default_branch: defaultBranch,
            branches: branches.map(({ protected: _p, ...rest }) => rest),
            truncated: comparisonTruncated,
            next_step: comparisonTruncated
              ? `Returned ${branches.length} branches whose merge state GitHub proved inside the host-safe budget. Retry to reassess omitted branches; do not infer that an omitted branch is unmerged.`
              : mergedCount
              ? `${mergedCount} branch(es) are already merged into ${defaultBranch}. Delete them with action:'delete', merged_only:true.`
              : `Nothing is safely deletable — no branch other than ${defaultBranch} is fully merged.`
          };
        }

        if (comparisonTruncated && input.merged_only === true) {
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: 'Forge could not prove the merge state of the complete branch set inside one host-safe call, so merged_only cleanup deleted nothing. Retry the same call later or delete one named branch from a complete list.',
            retryable: true
          });
        }
        if (paginationTruncated && input.branch !== undefined && !raw.some((entry) => entry.name === text(input.branch))) {
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: `Forge could not finish listing branches before the host-safe deadline, so it cannot prove that ${text(input.branch)} is absent and deleted nothing. Retry the same call later.`,
            retryable: true
          });
        }
        if (input.branch !== undefined && raw.some((entry) => entry.name === text(input.branch)) && !branches.some((entry) => entry.name === text(input.branch))) {
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: `Forge found ${text(input.branch)} but could not prove its current merge state, so it deleted nothing. Retry the same call later.`,
            retryable: true
          });
        }

        if (input.expected_sha !== undefined && input.merged_only === true) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'This call is invalid because expected_sha can guard only one named branch, while merged_only:true selects a batch. Remove expected_sha for the batch, or pass one branch with its expected_sha.',
            retryable: false
          });
        }

        const wanted = input.merged_only === true
          ? branches.filter((entry) => entry.merged && !entry.is_default)
          : branches.filter((entry) => entry.name === (input.branch === undefined ? '' : text(input.branch)));
        if (!wanted.length) {
          if (input.merged_only === true) {
            return {
              repository: `${owner}/${repo}`,
              default_branch: defaultBranch,
              deleted: [],
              already_absent: [],
              refused: [],
              next_step: `No merged branches currently exist to delete in ${owner}/${repo}; this call deleted nothing.`
            };
          }
          if (input.idempotency_key !== undefined && input.branch !== undefined) {
            return {
              repository: `${owner}/${repo}`,
              default_branch: defaultBranch,
              deleted: [],
              already_absent: [text(input.branch)],
              refused: [],
              next_step: `${text(input.branch)} is already absent from GitHub; this call did not delete it.`
            };
          }
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `Forge cannot delete ${input.branch === undefined ? '(no branch supplied)' : text(input.branch)} because that branch does not exist in ${owner}/${repo}. Call forge_branches with action:'list' and choose a returned branch; nothing was deleted.`,
            retryable: false
          });
        }

        // A remote branch can still be the live backing ref for a workspace.
        // Deleting it is destructive even when its current tip is merged.
        const occupants = await listSlotOccupants(env.METADATA, slotTtlMs(env));
        const liveBranches = liveWorkspaceBranches(occupants, owner, repo, TERMINAL_STATES);

        const deleted: string[] = [];
        const alreadyAbsent: string[] = [];
        const refused: Array<{ branch: string; reason: string }> = [];
        for (const entry of wanted) {
          // Three refusals that no flag overrides, because each one destroys
          // something that cannot be recovered from Forge.
          if (entry.is_default) {
            refused.push({ branch: entry.name, reason: `${entry.name} is the default branch.` });
            continue;
          }
          if (entry.protected) {
            refused.push({ branch: entry.name, reason: `${entry.name} is protected on GitHub.` });
            continue;
          }
          if (liveBranches.has(entry.name)) {
            refused.push({
              branch: entry.name,
              reason: `${entry.name} backs a live Forge workspace and cannot be deleted while that workspace is active. Destroy or move the workspace deliberately, then retry.`
            });
            continue;
          }
          if (!entry.merged && input.force !== true) {
            refused.push({
              branch: entry.name,
              reason: `${entry.name} has commits that are not on ${defaultBranch}; deleting it would lose them. Pass force:true with a reason if that is intended.`
            });
            continue;
          }
          if (!entry.merged && !input.reason) {
            refused.push({ branch: entry.name, reason: 'force:true requires a reason, so the record says why unmerged work was discarded.' });
            continue;
          }
          // Narrow the listing/compare-to-delete race with an immediate SHA
          // read-back. GitHub REST has no conditional ref-delete primitive, so
          // this is a guard rather than a claim of atomic deletion.
          const expectedSha = input.expected_sha === undefined ? entry.sha : text(input.expected_sha);
          const deletion = await deleteGitHubBranchIfUnchanged(request, base, entry.name, expectedSha);
          if (deletion.outcome === 'deleted') deleted.push(entry.name);
          else if (deletion.outcome === 'already_absent') alreadyAbsent.push(entry.name);
          else refused.push({ branch: entry.name, reason: deletion.reason });
        }

        return {
          repository: `${owner}/${repo}`,
          default_branch: defaultBranch,
          deleted,
          already_absent: alreadyAbsent,
          refused,
          next_step: deleted.length
            ? `Deleted ${deleted.length} branch(es) on GitHub: ${deleted.join(', ')}.${refused.length ? ` ${refused.length} refused.` : ''}`
            : `Nothing was deleted. ${refused.map((entry) => entry.reason).join(' ')}`
        };
      },
      forge_merge: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        // The branch is Forge's, not the agent's, so it does not have to know
        // or repeat it. If one is supplied it must be the workspace's own —
        // merging some other branch is never what was meant.
        const workspaceBranch = ((await (await authorizedCoordinator(env, identity, workspaceId)).getState()) as { currentBranch?: string }).currentBranch;
        // `workspace` already resolved the workspace above; re-read just the
        // branch half of it (if the caller pinned one) to cross-check against
        // the workspace's actual branch — malformed input would already have
        // thrown inside resolveWorkspaceId, so this second parse cannot fail
        // where the first one succeeded.
        const requestedBranch = typeof input.workspace === 'string' && input.workspace.trim() && !isWorkspaceId(input.workspace)
          ? parseWorkspaceAddress(input.workspace.trim()).branch
          : undefined;
        const branch = requestedBranch === undefined ? (workspaceBranch ?? '') : requestedBranch;
        if (!branch) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: 'This workspace has no agent branch to merge yet — nothing has been edited. Call forge_edit to make a change, then call forge_merge again.',
            retryable: false
          });
        }
        if (workspaceBranch && branch !== workspaceBranch) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `This workspace is on ${workspaceBranch}, not ${branch}. Omit workspace, or pass workspace:'${workspaceBranch}', and forge_merge merges the one you have been editing.`,
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

        // Uncommitted changes in the working tree are not the same as
        // unpushed commits: forge_edit and forge_shell's own auto-commit both
        // already push what they do straight to origin, so a dirty tree here
        // means a raw write bypassed both of those and forge_merge has never
        // seen it. It used to commit and push that silently, which is the
        // other push this design removes — report it instead, naming the
        // files, and send the agent back to forge_edit to re-apply them
        // through the path that actually commits them.
        const status = await coordinator.gitStatus().catch(() => undefined);
        assertCleanForMerge(status);

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

        // The commits must be somewhere durable before anything is promised to a
        // human. Under remote-first editing they already are: forge_edit put
        // them on origin/<branch> as it made them. Verify that with the same
        // GitHub API path forge_edit uses — forge_merge itself never pushes,
        // so there is nothing to fall back to if the branch is not there.
        // That fallback (stage, then force-push the feature branch) is what
        // 403'd in the wild: an agent's commit was already on origin,
        // forge_merge pushed it again, and the whole merge was reported
        // broken while the work sat safely on the branch the whole time.
        const repository = state.repository as RepositoryRef;
        const request = await githubRequestForWorkspace(env, identity, { repository });
        const remoteHead = await verifyFeatureBranchOnOrigin(request, repository, branch);
        const staged = { ref: branch, commit: remoteHead, remote_sha: remoteHead };

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
            // Asserted from the ref actually read back off origin, not
            // hardcoded. verifyFeatureBranchOnOrigin already throws above when
            // this would be false, so reaching here always means true — but
            // the field still reads it off `remoteHead` rather than assuming
            // it, in case that guard ever changes.
            feature_branch_on_origin: Boolean(remoteHead)
          },
          next_step: `Echo only submission_receipt to the human. Branch ${branch}@${staged.remote_sha} is verified on origin; approve at ${approval.approval_url}.`
        };
      },
      forge_cloudflare_deploy: async (input) => {
        const identity = this.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
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
        const synced = await withDeadline(workspace.syncToRemoteHead(), 10_000);
        if (!synced?.synced) {
          throw new ForgeError({
            code: synced?.blockedByLocalChanges ? 'FORGE_GIT_DIRTY' : 'FORGE_GIT_FETCH_FAILED',
            message: synced?.blockedByLocalChanges
              ? 'Forge found preserved container writes and refused to reset over them before deploying. Use forge_edit to publish or discard those changes deliberately, then retry forge_cloudflare_deploy.'
              : 'Forge could not prove the checkout matches the GitHub branch before deploying, so no deploy started. Retry forge_cloudflare_deploy after checking forge_workspace_get.',
            retryable: !synced?.blockedByLocalChanges
          });
        }
        const started = asRecord(await workspace.processStart({
          command,
          cwd,
          environment: {
            ...attached.vars,
            CLOUDFLARE_API_TOKEN: token,
            CLOUDFLARE_ACCOUNT_ID: accountId
          },
          networkPolicy: 'development',
          expectedRevision: undefined,
          idempotencyKey: text(input.idempotency_key),
          approved: true,
        }));
        const startedValue = started.value && typeof started.value === 'object'
          ? started.value as Record<string, unknown>
          : started;
        const processId = startedValue.id ?? started.processId ?? started.id;
        if (typeof processId !== 'string' || !processId.startsWith('proc_')) {
          throw new ForgeError({
            code: 'FORGE_WORKSPACE_CONFLICT',
            message: 'The deploy process did not return a process id, so Forge cannot track its outcome. Call forge_process_list before retrying with a new idempotency key.',
            retryable: false
          });
        }
        const waited = await withDeadline(
          workspace.processWait({ processId: processId as ProcessId, timeoutMs: 15_000 }) as unknown as Promise<Record<string, unknown>>,
          16_000
        );
        if (!waited || waited.timedOut) {
          if (approvalId) await completeApproval(env, approvalId, true, { reusable: true });
          return {
            deployed: false,
            accepted: true,
            process_id: processId,
            approval_id: approvalId,
            next_step: `Deploy is still running as ${processId}. Call forge_process_wait with that process_id; do not restart it. Then retry forge_cloudflare_deploy with the same idempotency_key and approval_id to obtain a verified deploy_receipt.`
          };
        }
        const process = waited.process as { exitCode?: number };
        const logs = asRecord(await workspace.processLogs({ processId: processId as ProcessId }));
        const combined = String(logs.data ?? '');
        const redacted = await vaultService(env).redactOutput(combined, identity.tenantId as TenantId, workspaceId);
        if (process.exitCode !== 0) {
          if (approvalId) await completeApproval(env, approvalId, false);
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: `Wrangler deploy failed (exit ${String(process.exitCode)}). Inspect forge_process_logs for ${processId}; do not claim the Worker is live.`,
            retryable: true,
            details: { process_id: processId, exitCode: process.exitCode, output_tail: redacted.slice(-4_000) }
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
              signal: AbortSignal.timeout(8_000)
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
          accepted: true,
          process_id: processId,
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
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input)) as WorkspaceId;
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
        // One deadline covers startup and capture. A 30s startup budget followed
        // by the old 110s capture budget still lost the whole response at the
        // host's ~60s transport boundary.
        const toolDeadlineAt = Date.now() + 45_000;
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input)) as WorkspaceId;
        // Getting here used to cost four calls and a polling loop: start the dev
        // server, poll its logs until it booted, expose a preview, then capture.
        // That is the whole "how does my app look right now" loop, and it is the
        // shape a chat session is worst at. With no preview_id, Forge does it —
        // detect the dev command, start it, wait for it to answer, expose it —
        // so screenshotting your own app is one call, same as a live URL.
        const workspace = await authorizedCoordinator(env, identity, workspaceId);
        let previewId = input.preview_id ? text(input.preview_id) : '';
        if (!previewId) {
          const deadline = Math.min(toolDeadlineAt - 10_000, Date.now() + number(input.preview_wait_ms));
          let lastReason = 'the dev server did not start in time';
          for (;;) {
            const remainingMs = Math.max(250, Math.min(5_000, deadline - Date.now()));
            const started = await withDeadline(
              workspace.startReviewPreview({
                hostname: env.FORGE_PREVIEW_HOSTNAME,
                ttlSeconds: 3600
              }) as unknown as Promise<{ ready: boolean; previewId?: string; reason?: string }>,
              remainingMs
            ).catch((error: unknown) => ({
              ready: false as const,
              reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown'
            })) ?? { ready: false as const, reason: 'the workspace did not answer before the startup observation deadline' };
            if (started.ready && started.previewId) {
              previewId = started.previewId;
              break;
            }
            lastReason = started.reason ?? 'the dev server did not become ready';
            // No dev server to run is terminal — waiting cannot conjure one.
            if (lastReason.includes('no dev server command') || Date.now() >= deadline) {
              throw new ForgeError({
                code: 'FORGE_PREVIEW_UNAVAILABLE',
                message: lastReason.includes('no dev server command')
                  ? 'No dev server command was detected for this project, so there is nothing to screenshot. Start the server with forge_shell async:true, then call forge_preview again (omit preview_id) or pass preview_id once exposed.'
                  : `The preview was not ready inside this call's host-safe startup budget (${lastReason}). Check forge_process_logs, then retry forge_preview; do not restart an already-running server.`,
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
        const deadlineAt = toolDeadlineAt;
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
        const workspaceId = await resolveWorkspaceId(env, identity, { workspaceId: input.workspace_id, ...workspaceAddress(input) });
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
              message: 'This workspace belongs to a different project. Use owner/repo/branch (or none, to use the one you have open) to address a workspace in the current project instead.',
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
              message: 'This url_review artifact belongs to a different project. Call forge_review again from this project — it mints a fresh workspace and artifacts you can fetch.',
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
            message: 'No artifact with this artifact_id exists in the resolved workspace. Artifact ids do not carry over between workspaces — call forge_review, forge_shell, or whichever tool produced it again to get a fresh one.',
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
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
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
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input)) as WorkspaceId;
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
