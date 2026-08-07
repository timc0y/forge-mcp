import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import {
  ForgeError,
  ids,
  toForgeError,
  type CredentialProfileId,
  type TenantId,
  type WorkspaceId
} from '@forge/core';
import { registerForgeToolsV1, type ToolCallTelemetry } from '@forge/mcp-adapter-v1';
import {
  detectDurableWitness,
  observeProgressEvent,
  phiFromReceipt,
  progressGate,
  progressPotentialView,
  witnessIdFromReceipt,
  type ProgressStreakState
} from '@forge/application';
import type { ForgeToolHandler, LegacyForgeToolHandlers } from '@forge/mcp-core';
import { D1TaskStore } from '@forge/metadata-d1';
import { D1AuditStore } from '@forge/audit';
import { elicitInlineApproval } from './inline-approval';
import type { ForgeEvent } from '@forge/events';
import type { TaskId } from '@forge/task-core';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import type { Env } from './env';
import { workspaceOperations } from './workspace-operations';
import { credentialService } from './credentials';
import { deployProfileStore } from './deploy-profiles';
import { selectSecretsForSources, vaultService } from './vault';
import { reclaimStaleSlots, slotTtlMs } from './capacity';
import {
  completeApproval,
  getApprovalRecord,
  markApprovalApproved,
  requestApproval,
  requireApproval,
  signedApprovalUrl
} from './github';
import { hashArgs, recordToolCall, priorIdenticalFailures, repeatCallGuidance } from './tool-call-log';
import { appendWorkspaceActivity } from './workspace-activity';
import { claimExternalMutation, readExternalMutationReceipt, recordExternalMutationReceipt } from './external-mutation-idempotency';
import { getLatestDeferredActionForBranch } from './deferred-actions';
import { systemToolHandlers } from './handlers/system';
import { taskToolHandlers } from './handlers/tasks';
import { reviewArtifactToolHandlers } from './handlers/review-artifacts';
import { repositoryWorkspaceToolHandlers } from './handlers/repository-workspace';
import { executionToolHandlers } from './handlers/execution';
import { directChatToolHandlers } from './handlers/direct-chat';
import { ChatOperationStore, issueChatOperationStatusUrl, matchesChatOperationReference, reconcileChatOperation } from './chat-operations';
import type { HandlerIdentity, SessionHandlerDependencies } from './handlers/types';
import { executorCoordinator, sha256, withDeadline } from './handlers/helpers';
import { FORGE_MCP_INSTRUCTIONS } from './mcp-guidance';
import { isWorkspaceId } from './workspace-resolve';
import { isDirectExecutorStartupPending, waitForDirectExecutorReady } from './direct-executor';

const SELECTED_CREDENTIAL_PROFILE_KEY = 'selected-credential-profile';
const PROGRESS_POTENTIAL_KEY = 'forge_progress_potential_v1';

type SessionProps = HandlerIdentity;

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

function annotateProgressPotential(result: unknown, state: ProgressStreakState, warning?: string): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!warning && state.streak === 0) return result;
  const view = progressPotentialView(state);
  const record = { ...(result as Record<string, unknown>) };
  if (warning) {
    record.next_step = typeof record.next_step === 'string' ? `${warning} ${record.next_step}` : warning;
  }
  return {
    ...record,
    progress_potential: {
      ...view,
      ...(warning ? { warning } : {})
    }
  };
}

export class ForgeMcpSession extends McpAgent<Env, unknown, SessionProps> {
  // Recreated in init after McpAgent has hydrated request props.
  server = new McpServer({ name: 'Forge MCP', version: '0.1.0' });

  async init(): Promise<void> {
    this.server = new McpServer(
      { name: 'Forge MCP', version: '0.1.0' },
      { instructions: FORGE_MCP_INSTRUCTIONS }
    );
    registerForgeToolsV1(
      this.server,
      this.directHandlers(),
      (event) => {
        void this.onToolCallTelemetry(event);
      }
    );
  }

  private async onToolCallTelemetry(event: ToolCallTelemetry): Promise<void> {
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
    // Workspace-scoped tools address via `workspace` (owner/repo#branch, bare
    // branch, or a ws_ id) — not a dedicated workspace_id input. Prefer a ws_
    // locator when the caller passed one; otherwise recover from the result
    // receipt (every workspace-scoped handler still returns workspace_id /
    // workspaceId). That association is what forge_observer_activity filters by.
    const rawWorkspace = typeof event.input.workspace === 'string' ? event.input.workspace.trim() : '';
    const workspaceId = (rawWorkspace && isWorkspaceId(rawWorkspace))
      ? rawWorkspace
      : workspaceIdFromResult(event.result);
    const waitUntil = (this.ctx as unknown as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil;
    const argsHash = await hashArgs(event.input);
    // The payload trail. Written alongside the counter so a failure can be
    // diagnosed from exactly what the agent sent and exactly what it read
    // back, without waiting for someone to reproduce it.
    waitUntil?.(
      recordToolCall(this.env, {
        requestId: typeof (this.props as SessionProps & { requestId?: unknown })?.requestId === 'string'
          ? (this.props as SessionProps & { requestId: string }).requestId
          : undefined,
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
        argsHash
      }).catch((error) => {
        console.error('forge_tool_call_log_failed', { name: error instanceof Error ? error.name : 'unknown' });
      })
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
      }).catch((error) => {
        console.error('forge_workspace_activity_failed', { name: error instanceof Error ? error.name : 'unknown' });
      })
    );
    if (workspaceId) {
      waitUntil?.(
        workspaceOperations(this.env, workspaceId).appendLiveActivity({
          tool: event.tool,
          status: event.status,
          durationMs: event.durationMs,
          errorCode: event.errorCode
        }).catch((error) => {
          console.error('forge_live_activity_failed', { name: error instanceof Error ? error.name : 'unknown' });
        })
      );
    }
  }

  // Append-only "what actually happened" trail for the handful of mutating,
  // consequential actions (GitHub edit, PR create, task finish, workspace destroy) —
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

  /** Runs the shared approval and idempotency protocol for consequential PR writes. */
  private async runApprovedPullRequestMutation<TReceipt extends Record<string, unknown>>(args: {
    identity: SessionProps;
    owner: string;
    repo: string;
    number: number;
    action: 'close' | 'merge';
    idempotencyKey?: string;
    intent: Record<string, unknown>;
    approvalPayload: Record<string, unknown>;
    approvalId?: string;
    execute: () => Promise<TReceipt>;
  }): Promise<TReceipt | (TReceipt & { replayed: true })> {
    const { identity, owner, repo, number, action, idempotencyKey, intent, approvalPayload, execute } = args;
    const mutationScope = `forge_pr:${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const mutationIntentHash = idempotencyKey ? await sha256(JSON.stringify(intent)) : undefined;
    if (idempotencyKey && mutationIntentHash) {
      const replay = await readExternalMutationReceipt(this.env, { tenantId: identity.tenantId, scope: mutationScope, idempotencyKey, intentHash: mutationIntentHash });
      if (replay) return { ...replay, replayed: true } as TReceipt & { replayed: true };
    }

    let approvalId = args.approvalId;
    const approvalWorkspace = `repository:${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const verb = action === 'close' ? 'Close' : 'Merge';
    if (!approvalId) {
      const approval = await requestApproval(this.env, identity, approvalWorkspace, 'pull_request.mutate', `${verb} pull request #${number}`, approvalPayload);
      if (approval.already_approved) approvalId = approval.approval_id;
      else {
        const inline = await this.tryResolveApprovalInline(identity, approval, `${verb} pull request #${number}`);
        if (!inline) {
          throw new ForgeError({
            code: 'FORGE_APPROVAL_REQUIRED',
            message: `${action === 'close' ? 'Closing' : 'Merging'} pull request #${number} needs human approval. Open the approval URL, approve, then retry with approval_id and the same idempotency_key.`,
            retryable: false,
            details: { kind: 'approval', action: 'pull_request.mutate', ...approval }
          });
        }
        approvalId = inline;
      }
    }
    await requireApproval(this.env, identity, approvalId, approvalWorkspace, 'pull_request.mutate', approvalPayload, { consume: false });
    const claim = idempotencyKey && mutationIntentHash
      ? await claimExternalMutation(this.env, { tenantId: identity.tenantId, scope: mutationScope, idempotencyKey, intentHash: mutationIntentHash })
      : undefined;
    if (claim?.kind === 'replay') return { ...claim.receipt, replayed: true } as TReceipt & { replayed: true };
    await requireApproval(this.env, identity, approvalId, approvalWorkspace, 'pull_request.mutate', approvalPayload);
    try {
      const receipt = await execute();
      if (idempotencyKey && claim?.kind === 'claimed') {
        await recordExternalMutationReceipt(this.env, { tenantId: identity.tenantId, scope: mutationScope, idempotencyKey, ownerToken: claim.ownerToken, receipt });
      }
      await completeApproval(this.env, approvalId, true);
      return receipt;
    } catch (error) {
      await completeApproval(this.env, approvalId, false).catch(() => undefined);
      throw error;
    }
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
      const reclaimed = await reclaimStaleSlots(env.METADATA, slotTtlMs(env), Date.now());
      for (const slot of reclaimed) {
        const reapedId = slot.workspaceId as WorkspaceId;
        try {
          const destroyId = workflowInstanceId('destroy', reapedId);
          // Stale execution state is disposable; only forge_edit persists code.
          await workspaceOperations(env, reapedId).requestDestroy({ idempotencyKey: `reap-${destroyId}`, force: true });
          await env.DESTROY_WORKFLOW.create({
            id: destroyId,
            params: { workspaceId: reapedId, idempotencyKey: `reap-${destroyId}`, preserveArtifacts: true, force: true }
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
   * Durable Progress Potential (Φ-gate): refuse progress-seeking tools when
   * the session has had too many successes without a durable witness
   * (forge_edit commit_url, merge submit, deps ready). Discrete Lyapunov
   * control for MCP tool streams — see packages/application progress-potential.
   */
  private withProgressPotential(handlers: LegacyForgeToolHandlers): LegacyForgeToolHandlers {
    const wrapped = {} as LegacyForgeToolHandlers;
    for (const name of Object.keys(handlers) as Array<keyof LegacyForgeToolHandlers>) {
      const original = handlers[name] as ForgeToolHandler;
      wrapped[name] = (async (input: Record<string, unknown>) => {
        const tool = String(name);
        const prev = (await this.ctx.storage.get<ProgressStreakState>(PROGRESS_POTENTIAL_KEY)) ?? null;
        const gate = progressGate(prev, tool);
        if (!gate.allow) {
          throw new ForgeError({
            code: 'FORGE_VALIDATION_FAILED',
            message: gate.next_step,
            retryable: false,
            details: {
              progress_potential: progressPotentialView(prev),
              reason: gate.reason,
              allowedNextActions: gate.allowedNextActions,
              next_step: gate.next_step,
              stopRepeating: true
            }
          });
        }
        const result = await original(input);
        const argsHash = await hashArgs(input);
        const durableWitness = detectDurableWitness(tool, result);
        const next = observeProgressEvent(prev, {
          tool,
          durableWitness,
          phiNow: phiFromReceipt(result),
          witnessId: durableWitness ? witnessIdFromReceipt(tool, result) : undefined,
          argsHash,
          status: 'success'
        });
        await this.ctx.storage.put(PROGRESS_POTENTIAL_KEY, next);
        return annotateProgressPotential(result, next, 'warning' in gate ? gate.warning : undefined);
      }) as LegacyForgeToolHandlers[typeof name];
    }
    return wrapped;
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
  private withRepeatDetection(handlers: LegacyForgeToolHandlers): LegacyForgeToolHandlers {
    const wrapped = {} as LegacyForgeToolHandlers;
    for (const name of Object.keys(handlers) as Array<keyof LegacyForgeToolHandlers>) {
      const original = handlers[name] as ForgeToolHandler;
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
      }) as LegacyForgeToolHandlers[typeof name];
    }
    return wrapped;
  }

  private handlers(options: { inlineApprovals?: boolean } = {}): LegacyForgeToolHandlers {
    const env = this.env;
    const deps: SessionHandlerDependencies = {
      identity: () => this.identity(),
      loadTask: (taskId) => this.loadTask(taskId),
      selectedCredentialProfileId: (identity) => this.selectedCredentialProfileId(identity),
      reclaimStaleWorkspaceSlots: () => this.reclaimStaleWorkspaceSlots(),
      recordAudit: (type, tenantId, payload, extra) => this.recordAudit(type, tenantId, payload, extra),
      tryResolveApprovalInline: options.inlineApprovals === false
        ? async () => null
        : (identity, approval, reason) => this.tryResolveApprovalInline(identity, approval, reason),
      runApprovedPullRequestMutation: (args) => this.runApprovedPullRequestMutation(args),
      ctx: this.ctx
    };
    return {
      ...systemToolHandlers(env, () => this.identity()),
      ...taskToolHandlers(env, deps),
      ...reviewArtifactToolHandlers(env, deps),
      ...repositoryWorkspaceToolHandlers(env, deps),
      ...executionToolHandlers(env, deps)
    };
  }

  /** Bridge the direct Chat facade to the old implementation while keeping all IDs private. */
  private directHandlers() {
    // Direct Chat never waits inside the MCP turn for a human. Hosted approval
    // links must be terminal receipts that Forge redeems server-side.
    const legacy = this.handlers({ inlineApprovals: false });
    const workspaceFor = async (repository: { owner: string; repo: string }, ref: string): Promise<{ workspace: string; ref: string }> => {
      let created: Record<string, unknown>;
      try {
        created = await legacy.forge_workspace_create!({
          repository: { provider: 'github', owner: repository.owner, name: repository.repo },
          ref,
          runtime: 'node-24',
          persistence: 'ephemeral',
          bootstrap: true,
          idempotency_key: `direct-${crypto.randomUUID()}`
        }) as Record<string, unknown>;
      } catch (error) {
        const forge = toForgeError(error);
        const existing = Array.isArray(forge.details?.existing)
          ? forge.details.existing as Array<Record<string, unknown>>
          : [];
        const matching = existing.find((entry) => !ref || entry.branch === ref);
        if (!matching || typeof matching.workspace_id !== 'string') throw error;
        created = {
          workspace_id: matching.workspace_id,
          ...(typeof matching.branch === 'string' ? { current_branch: matching.branch } : {})
        };
      }
      const workspace = created.workspace_id;
      if (typeof workspace !== 'string') throw new ForgeError({ code: 'FORGE_WORKSPACE_NOT_READY', message: 'Forge could not prepare private execution for this GitHub ref; retry forge_run once.', retryable: true });
      return {
        workspace,
        ref: typeof created.current_branch === 'string' && created.current_branch.trim() ? created.current_branch : ref
      };
    };
    const ensureExecutorReady = async (workspace: string): Promise<void> => {
      const identity = this.identity();
      const coordinator = workspaceOperations(this.env, workspace);
      await waitForDirectExecutorReady(
        async () => {
          await executorCoordinator(this.env, identity, workspace);
        },
        async () => {
          const binding = await withDeadline(coordinator.getAuthorizationBinding(), 2_000);
          return binding ? { state: binding.state } : undefined;
        }
      );
    };
    const executorAction = (kind: 'run' | 'screenshot' | 'deploy'): 'forge_run' | 'forge_screenshot' | 'forge_deploy' => {
      if (kind === 'screenshot') return 'forge_screenshot';
      if (kind === 'deploy') return 'forge_deploy';
      return 'forge_run';
    };
    const executorLabel = (kind: 'run' | 'screenshot' | 'deploy'): string => {
      if (kind === 'screenshot') return 'screenshot';
      if (kind === 'deploy') return 'deployment';
      return 'command';
    };
    const existingExecutor = async (input: {
      identity: HandlerIdentity;
      repository: { owner: string; repo: string };
      ref: string;
      kind: 'run' | 'screenshot' | 'deploy';
    }): Promise<{ workspace: string; ref: string; startupOperationId?: string } | { progress: Record<string, unknown> } | undefined> => {
      const repository = `${input.repository.owner}/${input.repository.repo}`;
      const repositoryRef = `${repository}#${input.ref}`;
      const store = new ChatOperationStore(this.env.METADATA);
      const recent = await store.listRecent(input.identity.tenantId, input.identity.projectId, repository);
      const candidate = recent.find((operation) =>
        operation.kind === input.kind
        && operation.state === 'running'
        && matchesChatOperationReference(operation, repositoryRef, input.ref)
        && typeof operation.result?.workspace_id === 'string'
        && (operation.result?.executor_starting === true || operation.result?.executor_ready === true)
      );
      if (!candidate) return undefined;
      const current = await reconcileChatOperation(this.env, input.identity.tenantId, candidate);
      const workspace = current.result?.workspace_id;
      const effectiveRef = current.repository_ref?.split('#', 2)[1];
      if (current.state !== 'running' || typeof workspace !== 'string' || typeof effectiveRef !== 'string' || !effectiveRef) return undefined;
      if (current.result?.executor_ready === true) return { workspace, ref: effectiveRef, startupOperationId: current.id };
      if (current.result?.executor_starting !== true) return undefined;
      return {
        progress: {
          state: 'running',
          status: 'running',
          progress_state: 'executor_starting',
          summary: current.summary,
          effective_ref: effectiveRef,
          status_url: await issueChatOperationStatusUrl(this.env, input.identity.tenantId, current.id)
        }
      };
    };
    const recordExecutorStartup = async (input: {
      identity: HandlerIdentity;
      repository: { owner: string; repo: string };
      ref: string;
      kind: 'run' | 'screenshot' | 'deploy';
      workspace: string;
      requestedRef?: string;
      operationId?: string;
    }): Promise<Record<string, unknown>> => {
      const repository = `${input.repository.owner}/${input.repository.repo}`;
      const repositoryRef = `${repository}#${input.ref}`;
      const operationId = input.operationId ?? ids.operation();
      const label = executorLabel(input.kind);
      const store = new ChatOperationStore(this.env.METADATA);
      await store.create({
        id: operationId,
        tenantId: input.identity.tenantId,
        projectId: input.identity.projectId,
        repository,
        repositoryRef,
        kind: input.kind,
        state: 'running',
        summary: `Forge is starting the private executor; no ${label} has run yet.`,
        result: {
          workspace_id: input.workspace,
          executor_starting: true,
          requested_action: executorAction(input.kind),
          ...(input.requestedRef && input.requestedRef !== input.ref ? { requested_ref: input.requestedRef } : {})
        }
      });
      // Provisioning was already requested by executorCoordinator. Do not
      // create a second background command workflow: status/branch recovery
      // observes the startup, and the user retries the public action when it
      // is ready.
      return {
        state: 'running',
        status: 'running',
        progress_state: 'executor_starting',
        summary: `Forge is starting the private executor; no ${label} has run yet.`,
        effective_ref: input.ref,
        status_url: await issueChatOperationStatusUrl(this.env, input.identity.tenantId, operationId)
      };
    };
    const requestedRefResult = (requestedRef: string | undefined, effectiveRef: string): Record<string, unknown> =>
      requestedRef && requestedRef !== effectiveRef ? { requested_ref: requestedRef } : {};
    const closeExecutorStartup = async (input: {
      identity: HandlerIdentity;
      operationId?: string;
      effectiveRef: string;
      state: 'completed' | 'failed';
      summary: string;
    }): Promise<void> => {
      if (!input.operationId) return;
      await new ChatOperationStore(this.env.METADATA).complete(input.identity.tenantId, input.operationId, {
        state: input.state,
        summary: input.summary,
        result: {
          effective_ref: input.effectiveRef
        }
      }).catch(() => undefined);
    };
    const prepareExecutor = async (input: {
      identity: HandlerIdentity;
      repository: { owner: string; repo: string };
      ref: string;
      kind: 'run' | 'screenshot' | 'deploy';
      operationId?: string;
    }): Promise<{ workspace: string; ref: string; startupOperationId?: string } | { progress: Record<string, unknown> }> => {
      const existing = await existingExecutor(input);
      if (existing) return existing;
      const prepared = await workspaceFor(input.repository, input.ref);
      const workspace = prepared.workspace;
      try {
        await ensureExecutorReady(workspace);
      } catch (error) {
        if (isDirectExecutorStartupPending(error)) {
          try {
            return {
              progress: await recordExecutorStartup({
                ...input,
                ref: prepared.ref,
                requestedRef: input.ref,
                workspace
              })
            };
          } catch (recordError) {
            await legacy.forge_workspace_destroy!({
              workspace,
              force: true,
              idempotency_key: `direct-${input.kind}-startup-failed-${input.identity.tenantId}-${input.identity.projectId}-${input.repository.owner}-${input.repository.repo}-${input.ref}`.slice(0, 190)
            }).catch(() => undefined);
            throw recordError;
          }
        }
        await legacy.forge_workspace_destroy!({
          workspace,
          force: true,
          idempotency_key: `direct-${input.kind}-prepare-failed-${input.identity.tenantId}-${input.identity.projectId}-${input.repository.owner}-${input.repository.repo}-${input.ref}`.slice(0, 190)
        }).catch(() => undefined);
        throw error;
      }
      return { workspace, ref: prepared.ref };
    };
    return directChatToolHandlers(this.env, {
      identity: () => this.identity(),
      privateOperations: {
        run: async (input) => {
          const repository = `${input.repository.owner}/${input.repository.repo}`;
          const operationId = ids.operation();
          const store = new ChatOperationStore(this.env.METADATA);
          const prepared = await prepareExecutor({
            identity: input.identity,
            repository: input.repository,
            ref: input.ref,
            kind: 'run',
            operationId
          });
          if ('progress' in prepared) return prepared.progress;
          const workspace = prepared.workspace;
          const repositoryRef = `${repository}#${prepared.ref}`;
          const requestedRef = input.ref.trim() || prepared.ref;
          const requestedRefFields = requestedRefResult(requestedRef, prepared.ref);
          try {
            const value = await legacy.forge_shell!({
              workspace, command: input.command, cwd: input.cwd ?? '/workspace/repo', timeout_ms: input.timeoutMs,
              environment: {}, network_policy: 'development', output_limit_bytes: 200_000, compact: true,
              mode: 'mutating', idempotency_key: `direct-run-${operationId}`
            }) as Record<string, unknown>;
            const processId = typeof value.processId === 'string'
              ? value.processId
              : typeof value.process_id === 'string' ? value.process_id : undefined;
            const running = value.status === 'running' || Boolean(processId);
            if (running && processId) {
              await store.create({
                id: operationId, tenantId: input.identity.tenantId, repository, repositoryRef,
                projectId: input.identity.projectId,
                kind: 'run', state: 'running', summary: 'Command is still running.',
                result: { workspace_id: workspace, process_id: processId, ...requestedRefFields }
              });
              await closeExecutorStartup({
                identity: input.identity,
                operationId: prepared.startupOperationId,
                effectiveRef: prepared.ref,
                state: 'completed',
                summary: 'Private executor handed the command to its managed operation.'
              });
              await this.env.CHAT_OPERATION_WORKFLOW.create({
                id: `chat-operation-${operationId}`,
                params: { tenantId: input.identity.tenantId, operationId }
              });
              return {
                ...value,
                effective_ref: prepared.ref,
                chat_operation_id: operationId,
                status_url: await issueChatOperationStatusUrl(this.env, input.identity.tenantId, operationId)
              };
            }
            await store.create({
              id: operationId, tenantId: input.identity.tenantId, repository, repositoryRef,
              projectId: input.identity.projectId,
              kind: 'run', state: 'completed', summary: String(value.result_summary ?? 'Command finished.'),
              result: { exit_code: value.exitCode ?? null, ...requestedRefFields }
            });
            await closeExecutorStartup({
              identity: input.identity,
              operationId: prepared.startupOperationId,
              effectiveRef: prepared.ref,
              state: 'completed',
              summary: 'Private executor handed the command to its managed operation.'
            });
            await legacy.forge_workspace_destroy!({ workspace, force: false, idempotency_key: `direct-run-cleanup-${operationId}` }).catch(() => undefined);
            return { ...value, effective_ref: prepared.ref, chat_operation_id: operationId };
          } catch (error) {
            await closeExecutorStartup({
              identity: input.identity,
              operationId: prepared.startupOperationId,
              effectiveRef: prepared.ref,
              state: 'failed',
              summary: 'Command failed after private executor startup.'
            });
            await legacy.forge_workspace_destroy!({ workspace, force: true, idempotency_key: `direct-run-failed-${operationId}` }).catch(() => undefined);
            throw error;
          }
        },
        screenshot: async (input) => {
          if (input.target.kind === 'url') {
            return await legacy.forge_review!({
              url: input.target.url, captures: input.captures, viewports: input.viewports,
              full_page: input.fullPage, time_budget_ms: 40_000
            }) as Record<string, unknown>;
          }
          const prepared = await prepareExecutor({
            identity: input.identity,
            repository: input.target.repository,
            ref: input.target.ref,
            kind: 'screenshot'
          });
          if ('progress' in prepared) return prepared.progress;
          const workspace = prepared.workspace;
          const startupOperationId = prepared.startupOperationId;
          const startupStore = startupOperationId ? new ChatOperationStore(this.env.METADATA) : undefined;
          const requestedRef = input.target.ref?.trim() || prepared.ref;
          const requestedRefFields = requestedRefResult(requestedRef, prepared.ref);
          try {
            const value = await legacy.forge_preview!({
              workspace,
              preview_wait_ms: 30_000,
              full_page: input.fullPage,
              captures: input.captures.map((capture) => ({
                route: capture.path,
                state: capture.state,
                ...(capture.selection ? { selection: capture.selection } : {}),
                ...(input.steps ? { steps: input.steps } : {})
              })),
              viewports: input.viewports
            }) as Record<string, unknown>;
            if (startupStore && startupOperationId) {
              await startupStore.complete(input.identity.tenantId, startupOperationId, {
                state: 'completed',
                summary: 'Responsive screenshot evidence captured.',
                result: { captured: true, effective_ref: prepared.ref, ...requestedRefFields }
              }).catch(() => undefined);
            }
            return { ...value, effective_ref: prepared.ref };
          } catch (error) {
            if (startupStore && startupOperationId) {
              await startupStore.complete(input.identity.tenantId, startupOperationId, {
                state: 'failed',
                summary: 'Screenshot failed after private executor startup.',
                result: { effective_ref: prepared.ref, ...requestedRefFields },
                errorMessage: 'Screenshot failed after private executor startup.'
              }).catch(() => undefined);
            }
            throw error;
          } finally {
            await legacy.forge_workspace_destroy!({
              workspace,
              force: false,
              idempotency_key: `direct-screenshot-cleanup-${input.target.repository.owner}-${input.target.repository.repo}-${prepared.ref}`.slice(0, 190)
            }).catch(() => undefined);
          }
        },
        environments: async (input) => {
          const tenantId = input.identity.tenantId as TenantId;
          const [listed, secrets] = await Promise.all([
            deployProfileStore(this.env.METADATA).list(
              tenantId,
              { owner: input.repository.owner, name: input.repository.repo }
            ),
            vaultService(this.env).list(tenantId)
          ]);
          const profiles = listed.map((profile) => ({
            label: profile.label,
            environment: profile.environment,
            provider: 'cloudflare',
            ready: profile.state === 'approved' && (() => {
              const selected = selectSecretsForSources(secrets, Object.values(profile.map_env));
              return selected.missing.length === 0 && selected.ambiguous.length === 0;
            })()
          }));
          return { environments: profiles };
        },
        deploy: async (input) => {
          const repository = `${input.repository.owner}/${input.repository.repo}`;
          const tenantId = input.identity.tenantId as TenantId;
          const profiles = await deployProfileStore(this.env.METADATA).list(tenantId, {
            owner: input.repository.owner,
            name: input.repository.repo
          });
          const profile = profiles.find((item) => item.environment === input.environment || item.label === input.environment);
          if (!profile) {
            throw new ForgeError({ code: 'FORGE_VALIDATION_FAILED', message: `No approved deployment environment named ${input.environment}. Call forge_environments first.`, retryable: false });
          }
          const vault = vaultService(this.env);
          const secrets = await vault.list(tenantId);
          const sourceNames = Object.values(profile.map_env);
          const selected = selectSecretsForSources(secrets, sourceNames);
          if (selected.missing.length > 0 || selected.ambiguous.length > 0) {
            const problem = selected.missing.length > 0
              ? `missing stored variables ${selected.missing.join(', ')}`
              : `variables exist in multiple secrets: ${selected.ambiguous.join(', ')}`;
            throw new ForgeError({
              code: 'FORGE_VALIDATION_FAILED',
              message: `Deployment environment ${input.environment} has ${problem}; use the Forge secrets page, then retry forge_deploy.`,
              retryable: false
            });
          }
          const operationId = ids.operation();
          const prepared = await prepareExecutor({
            identity: input.identity,
            repository: input.repository,
            ref: input.ref,
            kind: 'deploy',
            operationId
          });
          if ('progress' in prepared) return prepared.progress;
          const workspace = prepared.workspace;
          const repositoryRef = `${repository}#${prepared.ref}`;
          const requestedRef = input.ref.trim() || prepared.ref;
          const requestedRefFields = requestedRefResult(requestedRef, prepared.ref);
          try {
            for (const secret of selected.selected) await vault.attach(tenantId, secret.id, workspace);
            const value = await legacy.forge_deploy!({ workspace, profile_id: profile.profile_id, workflow: 'auto', include_output: false, idempotency_key: `direct-deploy-${input.repository.owner}-${input.repository.repo}-${prepared.ref}-${profile.profile_id}`.slice(0, 190) }) as Record<string, unknown>;
            await closeExecutorStartup({
              identity: input.identity,
              operationId: prepared.startupOperationId,
              effectiveRef: prepared.ref,
              state: 'completed',
              summary: 'Private executor handed the deployment to its managed operation.'
            });
            return { ...value, ...requestedRefFields };
          } catch (error) {
            const forge = toForgeError(error);
            const details = forge.details ?? {};
            if (forge.code === 'FORGE_APPROVAL_REQUIRED' && typeof details.approval_id === 'string') {
              const store = new ChatOperationStore(this.env.METADATA);
              const statusUrl = await issueChatOperationStatusUrl(this.env, input.identity.tenantId, operationId);
              await store.create({
                id: operationId,
                tenantId: input.identity.tenantId,
                projectId: input.identity.projectId,
                repository,
                repositoryRef,
                kind: 'deploy',
                state: 'approval_required',
                summary: 'Deployment is waiting for human approval.',
                result: { workspace_id: workspace, approval_id: details.approval_id, ...requestedRefFields }
              });
              const row = await this.env.METADATA.prepare(
                'SELECT request_payload FROM approvals WHERE id = ? AND tenant_id = ?'
              ).bind(details.approval_id, input.identity.tenantId).first<{ request_payload: string }>();
              if (!row) {
                await closeExecutorStartup({
                  identity: input.identity,
                  operationId: prepared.startupOperationId,
                  effectiveRef: prepared.ref,
                  state: 'failed',
                  summary: 'Deployment approval could not be recorded after private executor startup.'
                });
                await legacy.forge_workspace_destroy!({ workspace, force: true, idempotency_key: `direct-deploy-missing-approval-${operationId}` }).catch(() => undefined);
                throw error;
              }
              const payload = JSON.parse(row.request_payload) as Record<string, unknown>;
              await this.env.METADATA.prepare(
                'UPDATE approvals SET request_payload = ? WHERE id = ? AND tenant_id = ? AND state = \'pending\''
              ).bind(JSON.stringify({
                ...payload,
                chat_operation_id: operationId,
                project_id: input.identity.projectId,
                repository,
                repository_ref: repositoryRef,
                ...requestedRefFields,
                status_url: statusUrl
              }), details.approval_id, input.identity.tenantId).run();
              await closeExecutorStartup({
                identity: input.identity,
                operationId: prepared.startupOperationId,
                effectiveRef: prepared.ref,
                state: 'completed',
                summary: 'Private executor handed the deployment to human approval.'
              });
              return {
                state: 'approval_required',
                summary: forge.message,
                approval_url: details.approval_url,
                status_url: statusUrl,
                effective_ref: prepared.ref,
                chat_operation_id: operationId
              };
            }
            await closeExecutorStartup({
              identity: input.identity,
              operationId: prepared.startupOperationId,
              effectiveRef: prepared.ref,
              state: 'failed',
              summary: 'Deployment failed after private executor startup.'
            });
            await legacy.forge_workspace_destroy!({ workspace, force: true, idempotency_key: `direct-deploy-failed-${operationId}` }).catch(() => undefined);
            throw error;
          }
        },
        submit: async (input) => {
          const { workspace } = await workspaceFor(input.repository, input.branch);
          try {
            return await legacy.forge_merge!({ workspace, pr_base: input.baseRef ?? 'main', title: input.title, body: input.body ?? '', idempotency_key: `direct-submit-${input.repository.owner}-${input.repository.repo}-${input.branch}`.slice(0, 190) }) as Record<string, unknown>;
          } finally {
            await legacy.forge_workspace_destroy!({ workspace, force: false, idempotency_key: `direct-submit-cleanup-${input.repository.owner}-${input.repository.repo}-${input.branch}`.slice(0, 190) }).catch(() => undefined);
          }
        },
        status: async (input) => {
          const store = new ChatOperationStore(this.env.METADATA);
          const present = async (operation: Awaited<ReturnType<ChatOperationStore['get']>>) => {
            if (!operation) return null;
            operation = await reconcileChatOperation(this.env, input.identity.tenantId, operation);
            const retryTool = operation.kind === 'run'
              ? 'forge_run'
              : operation.kind === 'screenshot'
                ? 'forge_screenshot'
                : operation.kind === 'deploy'
                  ? 'forge_deploy'
                  : undefined;
            const next_action = operation.state === 'running' && operation.result?.executor_ready === true && retryTool
              ? { kind: 'tool' as const, tool: retryTool, message: `Private executor is ready. Retry ${retryTool} with the same repository and branch; no work has run yet.` }
              : operation.state === 'running' && operation.result?.executor_starting === true
                ? { kind: 'human' as const, message: 'Private executor is still starting. This status is branch-addressed; retry the original Forge action with the same repository and branch when it is ready.' }
                : undefined;
            return {
              chat_operation_id: operation.id,
              kind: operation.kind,
              state: operation.state,
              summary: operation.summary,
              repository: operation.repository,
              repository_ref: operation.repository_ref,
              result: operation.result && !('workspace_id' in operation.result) && !('process_id' in operation.result)
                ? operation.result
                : undefined,
              status_url: await issueChatOperationStatusUrl(this.env, input.identity.tenantId, operation.id),
              updated_at: operation.updated_at,
              ...(next_action ? { next_action } : {})
            };
          };
          if (input.reference.startsWith('op_')) {
            const operation = await store.getForProject(input.identity.tenantId, input.identity.projectId, input.reference);
            return present(operation);
          }
          const [repository, branch] = input.reference.split('#', 2);
          const requestedBranch = branch;
          if (repository && requestedBranch) {
            const [owner, name] = repository.split('/', 2);
            if (owner && name) {
              const deferred = await getLatestDeferredActionForBranch(
                this.env,
                input.identity.tenantId,
                input.identity.projectId,
                { owner, name },
                requestedBranch
              );
              if (deferred) {
                const approval = await getApprovalRecord(this.env, input.identity.tenantId, deferred.approvalId);
                const approvalUrl = approval && approval.state === 'pending' && Date.parse(approval.expiresAt) > Date.now()
                  ? await signedApprovalUrl(this.env, approval.id, input.identity.tenantId, approval.expiresAt)
                  : undefined;
                const state = deferred.state === 'awaiting_approval'
                  ? 'approval_required'
                  : deferred.state === 'executing'
                    ? 'running'
                    : deferred.state === 'failed'
                      ? 'failed'
                      : deferred.state === 'expired'
                        ? 'expired'
                        : 'completed';
                return {
                  kind: 'submit',
                  state,
                  summary: deferred.state === 'awaiting_approval'
                    ? 'Submission is awaiting human approval.'
                    : deferred.state === 'completed'
                      ? `Submission completed${deferred.result?.pr_url ? `: ${deferred.result.pr_url}` : '.'}`
                      : deferred.error ?? `Submission is ${deferred.state}.`,
                  repository,
                  repository_ref: `${repository}#${requestedBranch}`,
                  ...(approvalUrl ? { approval_url: approvalUrl } : {}),
                  ...(deferred.result ? { result: deferred.result } : {})
                };
              }
            }
          }
          const latest = requestedBranch
            ? (await store.listRecent(input.identity.tenantId, input.identity.projectId, repository)).find((operation) =>
                matchesChatOperationReference(operation, `${repository}#${requestedBranch}`, requestedBranch)
              )
            : undefined;
          return present(latest ?? null);
        }
      }
    });
  }
}
