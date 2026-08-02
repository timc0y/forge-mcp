import { ForgeError, ids, type WorkspaceId } from '@forge/core';
import { R2ArtifactStore } from '@forge/artifacts-r2';
import { D1TaskStore } from '@forge/metadata-d1';
import type { BrowserActionStep } from '@forge/browser-core';
import type { CommandClass } from '@forge/policy';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import { EXECUTOR_PROVISIONING_NEXT_STEP } from '@forge/application';
import type { Env } from '../env';
import { workspaceOperations, type WorkspaceOperations } from '../workspace-operations';
import type { HandlerIdentity } from './types';


// Operator policy: when on, in-workspace shell commands that would otherwise
// need a human click (dependency installs and other gated shell) run without an
// approval round trip. GitHub pull-request mutations have their own approval
// path and are intentionally NOT covered here.
export function autoApproveShell(env: Pick<Env, 'FORGE_AUTO_APPROVE_SHELL'>): boolean {
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
export const DEFAULT_AUTO_APPROVABLE_SHELL_CLASSES: readonly CommandClass[] = ['dependency_install', 'requires_approval'];

export const KNOWN_SHELL_CLASSES: ReadonlySet<string> = new Set<CommandClass>([
  'read_only', 'local_mutation', 'dependency_install', 'network_access',
  'external_side_effect', 'privileged', 'destructive', 'prohibited', 'requires_approval',
  'shell_evaluation'
]);

export function autoApprovableShellClasses(env: Pick<Env, 'FORGE_AUTO_APPROVE_SHELL_CLASSES'>): ReadonlySet<CommandClass> {
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
export function mayAutoApproveShell(
  env: Pick<Env, 'FORGE_AUTO_APPROVE_SHELL' | 'FORGE_AUTO_APPROVE_SHELL_CLASSES'>,
  classification: CommandClass,
  networkPolicy: string
): boolean {
  if (!autoApproveShell(env)) return false;
  if (networkPolicy === 'unrestricted_with_approval') return false;
  // `eval`, `source`, and `.` hand a second command program to the shell. This
  // classification is deliberately excluded even if a misconfigured class list
  // names it: an operator's broad auto-approve flag must not erase that seam.
  if (classification === 'shell_evaluation') return false;
  return autoApprovableShellClasses(env).has(classification);
}

/** Prefer the first https://…workers.dev URL wrangler prints after a deploy. */
export function parseWorkersDevUrl(output: string): string | null {
  const match = output.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev(?:\/[^\s"'<>]*)?/i);
  return match?.[0]?.replace(/[),.;]+$/u, '') ?? null;
}

export function parseWranglerWorkerName(output: string): string | null {
  const published = output.match(/Published\s+([A-Za-z0-9][A-Za-z0-9._-]*)/i);
  if (published?.[1]) return published[1];
  const deployed = output.match(/(?:Deployed|Uploading)\s+([A-Za-z0-9][A-Za-z0-9._-]*)/i);
  return deployed?.[1] ?? null;
}

export async function spillTextArtifact(
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
export async function recordUrlReviewOwner(
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
 * Object. D1 holds the same tenant/project binding and does not depend on the
 * executor being live, so authorization remains available for retained
 * artifacts after an execution workspace disappears.
 */
export async function lookupWorkspaceOwner(
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
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
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

export async function lookupUrlReviewOwner(
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
    // Table missing or transient DB error: treat as unbound so the caller denies.
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
export function summarizeStructure(
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
export async function mapWithConcurrency<T, R>(
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
export const REVIEW_CAPTURE_CONCURRENCY = 3;

// Roll a single evidence cell's heading-defect count up from its accessibility
// structure signal, so structuredContent can carry a flat findingCount without
// shipping the whole accessibility tree.
export function findingCountOf(cell: Record<string, unknown>): number {
  const accessibility = cell.accessibility as { structure?: { findingCount?: number } } | undefined;
  return accessibility?.structure?.findingCount ?? 0;
}

// Map a capture's raw interaction steps to the provider's bounded action vocabulary.
export function toActionSteps(
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

// A workspace's (tenant, project) binding is immutable for its lifetime, so a
// verified authorization can be cached to skip the extra getState() DO round
// trip on every subsequent file/git/shell/process call — the highest-frequency
// operations in a coding session. Keyed by the full tuple so it can never
// authorize a different tenant; bounded to stay a fixed-size per-isolate cache.
export const authorizedBindings = new Set<string>();
export const MAX_AUTHORIZED_BINDINGS = 2_000;

export async function authorizedCoordinator(
  env: Env,
  identity: HandlerIdentity,
  workspaceId: string
): Promise<WorkspaceOperations> {
  const value = workspaceOperations(env, workspaceId);
  const key = `${identity.tenantId}:${identity.projectId}:${workspaceId}`;
  if (authorizedBindings.has(key)) return value;
  const binding = await value.getAuthorizationBinding();
  if (binding.tenantId !== identity.tenantId || binding.projectId !== identity.projectId) {
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

/**
 * GitHub CRUD against a destroyed control-plane session. The authorization
 * cache above only proves tenant ownership once — without this live state
 * check, ChatGPT keeps forge_edit'ing a ws_ id after destroy and thinks the
 * session is still open.
 */
export async function liveControlPlaneCoordinator(
  env: Env,
  identity: HandlerIdentity,
  workspaceId: string
): Promise<WorkspaceOperations> {
  const value = await authorizedCoordinator(env, identity, workspaceId);
  const binding = await value.getAuthorizationBinding();
  if (binding.state === 'destroyed' || binding.state === 'destroying') {
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: `Workspace is ${binding.state}. GitHub commits on the forge/* branch remain. Call forge_workspace_create with the same repository (and that forge/* ref if needed); do not retry tools against the old workspace_id.`,
      retryable: false,
      details: {
        workspace_id: workspaceId,
        state: binding.state,
        allowedNextActions: ['forge_workspace_create', 'forge_observer_workspaces'],
        next_step: 'forge_workspace_create'
      }
    });
  }
  return value;
}

/**
 * Resolve an execution-only tool against the optional executor lifecycle.
 * GitHub CRUD never calls this: only commands, installs, previews and deploys
 * are allowed to wake the sandbox.
 */
export async function executorCoordinator(
  env: Env,
  identity: HandlerIdentity,
  workspaceId: string
): Promise<WorkspaceOperations> {
  const value = await authorizedCoordinator(env, identity, workspaceId);
  const binding = await value.getAuthorizationBinding();
  if (binding.state === 'ready' || binding.state === 'busy') return value;

  if (binding.state === 'requested') {
    const workflowId = workflowInstanceId('provision', workspaceId as WorkspaceId);
    try {
      await env.PROVISION_WORKFLOW.create({
        id: workflowId,
        params: { workspaceId: workspaceId as WorkspaceId, bootstrap: binding.bootstrapRequested }
      });
    } catch (error) {
      try {
        await env.PROVISION_WORKFLOW.get(workflowId);
      } catch {
        throw new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'The ephemeral executor could not start because its provisioning workflow was unavailable. No command ran; retry the same execution tool.',
          retryable: true,
          details: { workspace_id: workspaceId, operation_id: binding.operationId, cause: error instanceof Error ? error.message.slice(0, 300) : 'workflow_unavailable' }
        });
      }
    }
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: `The ephemeral executor is starting because this is the first execution tool used for the workspace. No command ran. Call forge_workspace_get; if state is still provisioning or bootstrapping, wait a few seconds and call forge_workspace_get again until ready, then retry the same execution tool. Do not create a second workspace.`,
      retryable: true,
      details: {
        workspace_id: workspaceId,
        operation_id: binding.operationId,
        state: 'provisioning',
        next_step: EXECUTOR_PROVISIONING_NEXT_STEP,
        allowedNextActions: ['forge_workspace_get']
      }
    });
  }

  if (binding.state === 'provisioning' || binding.state === 'bootstrapping') {
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_NOT_READY',
      message: `The ephemeral executor cannot run this tool because it is still ${binding.state}. No command ran. Call forge_workspace_get; if state is still provisioning or bootstrapping, wait a few seconds and call forge_workspace_get again until ready, then retry the same execution tool. Do not create a second workspace.`,
      retryable: true,
      details: {
        workspace_id: workspaceId,
        operation_id: binding.operationId,
        state: binding.state,
        next_step: EXECUTOR_PROVISIONING_NEXT_STEP,
        allowedNextActions: ['forge_workspace_get']
      }
    });
  }

  throw new ForgeError({
    code: 'FORGE_WORKSPACE_NOT_READY',
    message:
      binding.state === 'destroyed' || binding.state === 'destroying'
        ? `The ephemeral executor cannot run this tool because the workspace is ${binding.state}. GitHub commits on the forge/* branch are kept. Call forge_workspace_create with the same repository (and that forge/* ref if needed); do not retry tools against the old workspace_id.`
        : `The ephemeral executor cannot run this tool because the workspace is ${binding.state}. No command ran; inspect forge_workspace_get before retrying. Do not create a second workspace while this one is still live.`,
    retryable: false,
    details: { workspace_id: workspaceId, operation_id: binding.operationId, state: binding.state, allowedNextActions: ['forge_workspace_get', 'forge_workspace_create', 'forge_observer_workspaces'] }
  });
}

// Chunked base64 avoids quadratic per-character string building on large buffers.
export function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function text(value: unknown): string {
  return String(value);
}

export function number(value: unknown): number {
  return Number(value);
}

export function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

export function asRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

// The single `workspace` field ("owner/repo#branch", "owner/repo", bare
// branch, or a ws_ id) a tool input carries. ChatGPT often invents
// workspace_id from catalog wording — accept that alias rather than resolving
// an empty address and opening a wrong/duplicate workspace. forge_artifact_get
// still documents workspace_id explicitly for url-review screenshots.
export function workspaceAddress(input: Record<string, unknown>): { workspace?: unknown } {
  if (input.workspace !== undefined && input.workspace !== null && String(input.workspace).length > 0) {
    return { workspace: input.workspace };
  }
  if (typeof input.workspace_id === 'string' && input.workspace_id.trim()) {
    return { workspace: input.workspace_id.trim() };
  }
  return { workspace: input.workspace };
}

// True once the caller has given resolveWorkspaceId something to go on. Used
// where "nothing given" should mean "do not require exactly one workspace"
// rather than "resolve one" — e.g. forge_observer_activity, which is happy to
// report across every workspace when no address narrows it.
export function hasWorkspaceAddress(input: Record<string, unknown>): boolean {
  if (input.workspace !== undefined && input.workspace !== null && String(input.workspace).length > 0) return true;
  return typeof input.workspace_id === 'string' && input.workspace_id.trim().length > 0;
}

/** ChatGPT often runs wrangler via forge_shell and invents a deploy URL from stdout. */
export function isWranglerDeployCommand(command: string): boolean {
  return /\bwrangler\b/i.test(command) && /\b(deploy|publish|versions\s+deploy|containers\s+deploy|rollback)\b/i.test(command)
    && !/(^|\s)--dry-run(\s|$)/i.test(command);
}

export function wranglerShellDeployNextStep(): string {
  return 'Wrangler ran in the executor only — that is not a Forge deploy receipt. Call forge_secret_list → forge_secret_accounts → confirm account_id with the user → forge_secret_update if needed → forge_deploy with map_env, then echo only deploy_receipt.verified_url. Do not invent a workers.dev URL from shell stdout.';
}

export function shellQuote(value: string): string {
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
export function diffTotals(
  page: { totalFiles: number; totalAdditions: number; totalDeletions: number } | undefined
): { files: number; additions: number; deletions: number } | undefined {
  return page && { files: page.totalFiles, additions: page.totalAdditions, deletions: page.totalDeletions };
}

export function diffPaging(input: Record<string, unknown>): { cursor?: number; maxBytes?: number; paths?: string[] } {
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

export async function recordTaskRemoteSha(env: Env, workspaceId: WorkspaceId, remoteSha: string): Promise<void> {
  await new D1TaskStore(env.METADATA).getByWorkspace(workspaceId).then(async (task) => {
    if (!task) return;
    const now = new Date().toISOString();
    await new D1TaskStore(env.METADATA).put({
      ...task,
      remoteBranchSha: remoteSha,
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
export function idempotency(value: unknown): string {
  return value === undefined || value === null || value === '' ? crypto.randomUUID() : String(value);
}

/** Git's own object id for a blob: sha1("blob <bytes>\0" + content). */
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const buffer = new Uint8Array(header.length + body.length);
  buffer.set(header);
  buffer.set(body, header.length);
  const digest = await crypto.subtle.digest('SHA-1', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
