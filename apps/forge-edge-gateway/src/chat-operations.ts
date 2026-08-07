import type { Env } from './env';
import { BASE_CSS, forgeGlyph } from './ui';
import { workspaceOperations } from './workspace-operations';
import { parseWorkersDevUrl, parseWranglerWorkerName } from './handlers/helpers';
import { workflowInstanceId } from '@forge/workflows-cloudflare';
import type { ProcessId, WorkspaceId } from '@forge/core';

export type ChatOperationKind = 'run' | 'screenshot' | 'deploy' | 'submit';
export type ChatOperationState = 'running' | 'approval_required' | 'completed' | 'failed' | 'expired';

export interface ChatOperation {
  id: string;
  repository: string | null;
  repository_ref: string | null;
  kind: ChatOperationKind;
  state: ChatOperationState;
  summary: string;
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function executorAction(kind: ChatOperationKind): 'forge_run' | 'forge_screenshot' | 'forge_deploy' | undefined {
  if (kind === 'run') return 'forge_run';
  if (kind === 'screenshot') return 'forge_screenshot';
  if (kind === 'deploy') return 'forge_deploy';
  return undefined;
}

function executorObjectResult(result: Record<string, unknown>): Record<string, unknown> {
  return { ...result, executor_starting: true };
}

/** Match a durable branch address, including the original ref alias used when Forge cut forge/*. */
export function matchesChatOperationReference(operation: ChatOperation, repositoryRef: string, requestedRef: string): boolean {
  return operation.repository_ref === repositoryRef || operation.result?.requested_ref === requestedRef;
}

interface ChatOperationRow extends Omit<ChatOperation, 'result'> {
  tenant_id: string;
  project_id: string;
  result_json: string | null;
}

function parseResult(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function publicOperation(row: ChatOperationRow): ChatOperation {
  const { tenant_id: _tenant, project_id: _project, result_json, ...rest } = row;
  return { ...rest, result: parseResult(result_json) };
}

export class ChatOperationStore {
  constructor(private readonly db: D1Database) {}

  async create(input: {
    id: string;
    tenantId: string;
    projectId: string;
    repository?: string;
    repositoryRef?: string;
    kind: ChatOperationKind;
    state: ChatOperationState;
    summary: string;
    result?: Record<string, unknown>;
    errorMessage?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const terminal = ['completed', 'failed', 'expired'].includes(input.state) ? now : null;
    await this.db.prepare(
      `INSERT INTO chat_operations
       (id, tenant_id, project_id, repository, repository_ref, kind, state, summary, result_json, error_message, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      input.id, input.tenantId, input.projectId, input.repository ?? null, input.repositoryRef ?? null,
      input.kind, input.state, input.summary, input.result ? JSON.stringify(input.result) : null,
      input.errorMessage ?? null, now, now, terminal
    ).run();
  }

  async complete(tenantId: string, id: string, input: {
    state: Extract<ChatOperationState, 'completed' | 'failed' | 'expired'>;
    summary: string;
    result?: Record<string, unknown>;
    errorMessage?: string;
  }): Promise<void> {
    await this.update(tenantId, id, input);
  }

  async update(tenantId: string, id: string, input: {
    state: ChatOperationState;
    summary: string;
    result?: Record<string, unknown>;
    errorMessage?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const completedAt = ['completed', 'failed', 'expired'].includes(input.state) ? now : null;
    await this.db.prepare(
      `UPDATE chat_operations
       SET state = ?, summary = ?, result_json = ?, error_message = ?, updated_at = ?, completed_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).bind(
      input.state, input.summary, input.result ? JSON.stringify(input.result) : null,
      input.errorMessage ?? null, now, completedAt, tenantId, id
    ).run();
  }

  async get(tenantId: string, id: string): Promise<ChatOperation | null> {
    const row = await this.db.prepare(
      'SELECT * FROM chat_operations WHERE tenant_id = ? AND id = ?'
    ).bind(tenantId, id).first<ChatOperationRow>();
    return row ? publicOperation(row) : null;
  }

  async getForProject(tenantId: string, projectId: string, id: string): Promise<ChatOperation | null> {
    const row = await this.db.prepare(
      'SELECT * FROM chat_operations WHERE tenant_id = ? AND project_id = ? AND id = ?'
    ).bind(tenantId, projectId, id).first<ChatOperationRow>();
    return row ? publicOperation(row) : null;
  }

  async listRecent(tenantId: string, projectId: string, repository?: string, limit = 20): Promise<ChatOperation[]> {
    const bounded = Math.max(1, Math.min(50, limit));
    const statement = repository
      ? this.db.prepare(
          'SELECT * FROM chat_operations WHERE tenant_id = ? AND project_id = ? AND repository = ? ORDER BY updated_at DESC LIMIT ?'
        ).bind(tenantId, projectId, repository, bounded)
      : this.db.prepare(
          'SELECT * FROM chat_operations WHERE tenant_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT ?'
        ).bind(tenantId, projectId, bounded);
    const rows = await statement.all<ChatOperationRow>();
    return rows.results.map(publicOperation);
  }
}

export async function discardChatExecutor(env: Env, workspaceId: string, operationId: string): Promise<void> {
  const destroyId = workflowInstanceId('destroy', workspaceId as WorkspaceId);
  const requested = await workspaceOperations(env, workspaceId as WorkspaceId).requestDestroy({
    idempotencyKey: `chat-operation-${operationId}-${destroyId}`,
    force: false
  }).catch(() => null);
  if (requested && requested.state !== 'destroyed') {
    await env.DESTROY_WORKFLOW.create({
      id: destroyId,
      params: {
        workspaceId: workspaceId as WorkspaceId,
        idempotencyKey: `chat-operation-${operationId}-${destroyId}`,
        preserveArtifacts: true,
        force: false
      }
    }).catch(() => undefined);
  }
}

/** Observe a private managed process once; never starts or repeats work. */
export async function reconcileChatOperation(env: Env, tenantId: string, operation: ChatOperation): Promise<ChatOperation> {
  if (operation.state !== 'running' || !operation.result) return operation;
  const workspaceId = operation.result.workspace_id;
  const processId = operation.result.process_id;
  if (typeof workspaceId !== 'string') return operation;
  const workspace = workspaceOperations(env, workspaceId as WorkspaceId);

  // Direct chat deliberately records container startup as a running,
  // branch-addressed operation. Observe it here without starting a command;
  // the user/model must retry the public action once the executor is ready.
  const executorStarting = operation.result.executor_starting === true
    || operation.result.executor_ready === true;
  if (executorStarting && typeof processId !== 'string') {
    const binding = await workspace.getAuthorizationBinding().catch(() => null);
    if (!binding) return operation;
    const action = executorAction(operation.kind);
    const actionLabel = operation.kind === 'screenshot' ? 'screenshot' : operation.kind === 'deploy' ? 'deployment' : 'command';
    const store = new ChatOperationStore(env.METADATA);
    if (binding.state === 'ready' || binding.state === 'busy') {
      const summary = action
        ? `Private executor is ready. Retry ${action} with the same repository and branch; no ${actionLabel} has run yet.`
        : 'Private executor is ready. Retry the requested action with the same repository and branch.';
      if (operation.result.executor_ready !== true || operation.summary !== summary) {
        await store.update(tenantId, operation.id, {
          state: 'running',
          summary,
          result: {
            ...operation.result,
            executor_starting: false,
            executor_ready: true,
            executor_state: binding.state
          }
        });
        return await store.get(tenantId, operation.id) ?? operation;
      }
      return operation;
    }
    if (binding.state === 'failed' || binding.state === 'destroyed' || binding.state === 'destroying') {
      const summary = `Private executor could not start (${binding.state}). Retry ${action ?? 'the action'} with the same repository and branch.`;
      await store.complete(tenantId, operation.id, {
        state: 'failed',
        summary,
        result: {
          ...operation.result,
          executor_starting: false,
          executor_ready: false,
          executor_failed: true,
          executor_state: binding.state
        },
        errorMessage: summary
      });
      if (binding.state === 'failed') await discardChatExecutor(env, workspaceId, operation.id).catch(() => undefined);
      return await store.get(tenantId, operation.id) ?? operation;
    }
    const summary = `Private executor is ${binding.state}; no ${actionLabel} has run yet.`;
    if (operation.summary !== summary || operation.result.executor_state !== binding.state) {
      await store.update(tenantId, operation.id, {
        state: 'running',
        summary,
        result: executorObjectResult({ ...operation.result, executor_state: binding.state })
      });
      return await store.get(tenantId, operation.id) ?? operation;
    }
    return operation;
  }

  if (typeof processId !== 'string') return operation;
  const waited = await workspace.processWait({
    processId: processId as ProcessId,
    timeoutMs: 250
  }) as unknown as Record<string, unknown>;
  if (waited.timedOut === true) return operation;
  const process = waited.process && typeof waited.process === 'object'
    ? waited.process as Record<string, unknown>
    : {};
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : null;
  const store = new ChatOperationStore(env.METADATA);
  if (operation.kind === 'deploy') {
    const logs = await workspace.processLogs({ processId: processId as ProcessId }) as unknown as Record<string, unknown>;
    const output = String(logs.data ?? '');
    const expected = typeof operation.result.expected_url === 'string' ? operation.result.expected_url : null;
    const candidateUrl = expected ?? parseWorkersDevUrl(output);
    let deploymentUrl: string | null = null;
    let httpStatus: number | null = null;
    if (exitCode === 0 && candidateUrl) {
      try {
        const response = await fetch(candidateUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8_000) });
        httpStatus = response.status;
        deploymentUrl = response.ok ? candidateUrl : null;
      } catch {
        deploymentUrl = null;
      }
    }
    const success = exitCode === 0 && deploymentUrl !== null;
    await store.complete(tenantId, operation.id, {
      state: success ? 'completed' : 'failed',
      summary: success ? `Deployment verified at ${deploymentUrl}.` : exitCode === 0 ? 'Deployment finished, but Forge could not verify its URL.' : `Deployment failed${exitCode === null ? '.' : ` with exit ${exitCode}.`}`,
      result: {
        exit_code: exitCode,
        deployment_url: deploymentUrl,
        http_status: httpStatus,
        worker_name: parseWranglerWorkerName(output),
        ...(typeof operation.result.requested_ref === 'string' ? { requested_ref: operation.result.requested_ref } : {})
      }
    });
  } else {
    const logs = await workspace.processLogs({ processId: processId as ProcessId }) as unknown as Record<string, unknown>;
    const outputTail = String(logs.data ?? '').slice(-8_000);
    await store.complete(tenantId, operation.id, {
      state: exitCode === 0 ? 'completed' : 'failed',
      summary: exitCode === 0 ? 'Command completed successfully.' : `Command failed${exitCode === null ? '.' : ` with exit ${exitCode}.`}`,
      result: {
        exit_code: exitCode,
        ...(outputTail ? { output_tail: outputTail } : {}),
        ...(typeof operation.result.requested_ref === 'string' ? { requested_ref: operation.result.requested_ref } : {})
      }
    });
  }
  await discardChatExecutor(env, workspaceId, operation.id);
  return await store.get(tenantId, operation.id) ?? operation;
}

interface StatusClaims {
  tenant: string;
  operation: string;
  exp: number;
}

const STATUS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function encode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function decode(value: string): ArrayBuffer {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

export async function issueChatOperationStatusUrl(
  env: Pick<Env, 'FORGE_PUBLIC_ORIGIN' | 'FORGE_CAPABILITY_SIGNING_KEY'>,
  tenantId: string,
  operationId: string
): Promise<string> {
  const payload = encode(new TextEncoder().encode(JSON.stringify({
    tenant: tenantId, operation: operationId, exp: Date.now() + STATUS_TTL_MS
  } satisfies StatusClaims)));
  const signature = await crypto.subtle.sign(
    'HMAC', await key(env.FORGE_CAPABILITY_SIGNING_KEY), new TextEncoder().encode(payload)
  );
  return `${env.FORGE_PUBLIC_ORIGIN}/status/${operationId}?t=${encodeURIComponent(`${payload}.${encode(signature)}`)}`;
}

export async function verifyChatOperationStatusToken(
  env: Pick<Env, 'FORGE_CAPABILITY_SIGNING_KEY'>,
  token: string
): Promise<StatusClaims | null> {
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  try {
    const valid = await crypto.subtle.verify(
      'HMAC', await key(env.FORGE_CAPABILITY_SIGNING_KEY), decode(token.slice(dot + 1)),
      new TextEncoder().encode(payload)
    );
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(decode(payload))) as StatusClaims;
    return claims.exp > Date.now() && claims.tenant && claims.operation ? claims : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/gu, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string
  );
}

export async function chatOperationStatusPage(request: Request, env: Env, operationId: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get('t') ?? '';
  const claims = await verifyChatOperationStatusToken(env, token);
  if (!claims || claims.operation !== operationId) return new Response('This status link is invalid or has expired.', { status: 404 });
  const stored = await new ChatOperationStore(env.METADATA).get(claims.tenant, operationId);
  const operation = stored ? await reconcileChatOperation(env, claims.tenant, stored) : null;
  if (!operation) return new Response('This operation is no longer available.', { status: 404 });
  const detail = operation.error_message ?? operation.summary;
  const deploymentUrl = typeof operation.result?.deployment_url === 'string' ? operation.result.deployment_url : null;
  const outputTail = typeof operation.result?.output_tail === 'string' ? operation.result.output_tail : null;
  const resultBlock = deploymentUrl
    ? `<p><a href="${escapeHtml(deploymentUrl)}" rel="noopener">Open verified deployment →</a></p>`
    : outputTail
      ? `<pre>${escapeHtml(outputTail)}</pre>`
      : '';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Forge status</title><style>${BASE_CSS}</style></head>
<body><div class="wrap"><div class="topbar"><span class="mark"><span class="box">${forgeGlyph(19)}</span>Forge</span><span class="badge">${escapeHtml(operation.state)}</span></div>
<main><h1>${escapeHtml(operation.kind)}</h1><p>${escapeHtml(detail)}</p>${operation.repository_ref ? `<p><code>${escapeHtml(operation.repository_ref)}</code></p>` : ''}${resultBlock}<p>Updated ${escapeHtml(operation.updated_at)}</p></main></div></body></html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'private,no-store',
      'x-robots-tag': 'noindex,nofollow,noarchive', 'referrer-policy': 'no-referrer'
    }
  });
}
