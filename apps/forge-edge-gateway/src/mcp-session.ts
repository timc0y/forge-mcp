import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import {
  ForgeError,
  toForgeError,
  type CredentialProfileId,
  type TenantId,
  type WorkspaceId
} from '@forge/core';
import { registerForgeToolsV1, type ToolCallTelemetry } from '@forge/mcp-adapter-v1';
import { ToolCallTracker, hashArgs } from './telemetry';
import type { ForgeToolHandlers } from '@forge/mcp-core';
import { D1TaskStore } from '@forge/metadata-d1';
import { D1AuditStore } from '@forge/audit';
import { elicitInlineApproval } from './inline-approval';
import type { ForgeEvent } from '@forge/events';
import type { TaskId } from '@forge/task-core';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import type { Env } from './env';
import { workspaceOperations } from './workspace-operations';
import { credentialService } from './credentials';
import { reclaimStaleSlots, slotTtlMs } from './capacity';
import { registerLegacyWidgetStub } from './legacy-widget';
import {
  completeApproval,
  markApprovalApproved,
  requestApproval,
  requireApproval
} from './github';
import { recordToolCall, priorIdenticalFailures, repeatCallGuidance } from './tool-call-log';
import { appendWorkspaceActivity } from './workspace-activity';
import { claimExternalMutation, readExternalMutationReceipt, recordExternalMutationReceipt } from './external-mutation-idempotency';
import { systemToolHandlers } from './handlers/system';
import { taskToolHandlers } from './handlers/tasks';
import { reviewArtifactToolHandlers } from './handlers/review-artifacts';
import { repositoryWorkspaceToolHandlers } from './handlers/repository-workspace';
import { executionToolHandlers } from './handlers/execution';
import type { HandlerIdentity as SessionProps, SessionHandlerDependencies } from './handlers/types';
import { sha256 } from './handlers/helpers';
import { FORGE_MCP_INSTRUCTIONS, FORGE_PROMPT_HINTS } from './mcp-guidance';

const SELECTED_CREDENTIAL_PROFILE_KEY = 'selected-credential-profile';

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

export class ForgeMcpSession extends McpAgent<Env, unknown, SessionProps> {
  server = new McpServer(
    { name: 'Forge MCP', version: '0.1.0' },
    {
      instructions: FORGE_MCP_INSTRUCTIONS
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
        workspaceOperations(this.env, workspaceId).appendLiveActivity({
          tool: event.tool,
          status: event.status,
          durationMs: event.durationMs,
          errorCode: event.errorCode
        }).catch(() => undefined)
      );
    }
  }

  // Slash-command style entry points for project work in ChatGPT/Claude.
  // Prompt bodies live in mcp-guidance.ts so integrity tests can sweep them.
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
      ({ url, notes }) => userText(FORGE_PROMPT_HINTS['review-live-url']({ url, notes }))
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
      ({ repository, task }) => userText(FORGE_PROMPT_HINTS['start-task']({ repository, task }))
    );

    this.server.registerPrompt(
      'plan-work',
      {
        title: 'Plan work on a repository',
        description: 'Create a durable Forge task plan without allocating an executor or writing code yet.',
        argsSchema: {
          repository: z.string().describe('The repository to plan against, e.g. owner/name'),
          goal: z.string().describe('What the plan should accomplish')
        }
      },
      ({ repository, goal }) => userText(FORGE_PROMPT_HINTS['plan-work']({ repository, goal }))
    );

    this.server.registerPrompt(
      'iterate-ui',
      {
        title: 'Iterate on UI or design',
        description: 'Edit UI, verify with screenshots, and refine until phone and desktop look right.',
        argsSchema: {
          repository: z.string().describe('The repository to change, e.g. owner/name'),
          change: z.string().describe('The UI or design change to iterate on')
        }
      },
      ({ repository, change }) => userText(FORGE_PROMPT_HINTS['iterate-ui']({ repository, change }))
    );

    this.server.registerPrompt(
      'fix-bug',
      {
        title: 'Fix a bug',
        description: 'Reproduce cheaply, fix code and test together, verify narrowly, then submit a draft PR.',
        argsSchema: {
          repository: z.string().describe('The repository that has the bug, e.g. owner/name'),
          bug: z.string().describe('What is broken and how to recognise a fix')
        }
      },
      ({ repository, bug }) => userText(FORGE_PROMPT_HINTS['fix-bug']({ repository, bug }))
    );

    this.server.registerPrompt(
      'resume-task',
      {
        title: 'Resume a Forge task',
        description: 'Pick up after context compression or reconnect using the durable task handoff.',
        argsSchema: {
          task_id: z.string().optional().describe('Existing task id, if known'),
          repository: z.string().optional().describe('Repository to find the open task on, e.g. owner/name')
        }
      },
      ({ task_id, repository }) => userText(FORGE_PROMPT_HINTS['resume-task']({ task_id, repository }))
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
      ({ workspace_id }) => userText(FORGE_PROMPT_HINTS['prepare-draft-pr']({ workspace_id }))
    );
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
    const deps: SessionHandlerDependencies = {
      identity: () => this.identity(),
      loadTask: (taskId) => this.loadTask(taskId),
      selectedCredentialProfileId: (identity) => this.selectedCredentialProfileId(identity),
      reclaimStaleWorkspaceSlots: () => this.reclaimStaleWorkspaceSlots(),
      recordAudit: (type, tenantId, payload, extra) => this.recordAudit(type, tenantId, payload, extra),
      tryResolveApprovalInline: (identity, approval, reason) =>
        this.tryResolveApprovalInline(identity, approval, reason),
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
}
