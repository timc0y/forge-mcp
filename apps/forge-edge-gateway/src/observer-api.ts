import type { Env } from './env';
import { listSlotOccupants, slotTtlMs } from './capacity';
import { listWorkspaceActivity } from './workspace-activity';
import { workspaceOperations } from './workspace-operations';
import { describeWorkspaceLifecycle, LAZY_REQUESTED_NEXT_ACTIONS } from '@forge/application';

function parseRepository(raw: string): { owner: string; name: string } | null {
  const slash = raw.indexOf('/');
  if (slash <= 0) return null;
  return { owner: raw.slice(0, slash), name: raw.slice(slash + 1) };
}

function taskDocumentHints(documentJson: string): { changedFiles: string[]; checks: number } {
  try {
    const doc = JSON.parse(documentJson) as { changedFiles?: string[]; checks?: unknown[] };
    return {
      changedFiles: Array.isArray(doc.changedFiles) ? doc.changedFiles.slice(0, 12) : [],
      checks: Array.isArray(doc.checks) ? doc.checks.length : 0
    };
  } catch {
    return { changedFiles: [], checks: 0 };
  }
}

export async function buildLiveWorkspaceList(env: Env, tenantId: string) {
  const occupants = await listSlotOccupants(env.METADATA, slotTtlMs(env), Date.now(), tenantId);
  const live = occupants.filter((row) => row.state && !['destroyed', 'failed'].includes(row.state));
  const workspaceIds = live.map((row) => row.workspaceId);
  const workspaces = workspaceIds.length
    ? await env.METADATA.prepare(
        `SELECT id, repository, requested_ref, state, current_branch, current_commit, updated_at, base_commit
           FROM workspaces WHERE tenant_id = ?1 AND id IN (${workspaceIds.map((_, i) => `?${i + 2}`).join(', ')})`
      ).bind(tenantId, ...workspaceIds).all<{
        id: string;
        repository: string;
        requested_ref: string;
        state: string;
        current_branch: string | null;
        current_commit: string | null;
        updated_at: string;
        base_commit: string | null;
      }>().then((result) => result.results ?? [])
    : [];
  const byId = new Map(workspaces.map((row) => [row.id, row]));
  const tasks = workspaceIds.length
    ? await env.METADATA.prepare(
        `SELECT id, goal, state, branch, workspace_id, updated_at, document
           FROM tasks WHERE tenant_id = ?1 AND workspace_id IN (${workspaceIds.map((_, i) => `?${i + 2}`).join(', ')})
           ORDER BY updated_at DESC`
      ).bind(tenantId, ...workspaceIds).all<{
        id: string;
        goal: string;
        state: string;
        branch: string | null;
        workspace_id: string | null;
        updated_at: string;
        document: string;
      }>().then((result) => result.results ?? [])
    : [];
  const taskByWorkspace = new Map<string, (typeof tasks)[number]>();
  for (const task of tasks) {
    if (task.workspace_id && !taskByWorkspace.has(task.workspace_id)) taskByWorkspace.set(task.workspace_id, task);
  }

  return {
    generatedAt: new Date().toISOString(),
    pollIntervalMs: 5000,
    note:
      'state:requested with empty processes is healthy lazy create — use forge_files_read / forge_edit. Only poll when lifecycle is executor_starting.',
    workspaces: live.map((slot) => {
      const row = byId.get(slot.workspaceId);
      const task = taskByWorkspace.get(slot.workspaceId);
      const repo = row ? parseRepository(row.repository) : null;
      const hints = task ? taskDocumentHints(task.document) : { changedFiles: [], checks: 0 };
      const state = row?.state ?? slot.state ?? 'unknown';
      const branch = row?.current_branch ?? task?.branch ?? null;
      const head = row?.current_commit ? row.current_commit.slice(0, 12) : null;
      const lifecycle = describeWorkspaceLifecycle(state, {
        branch,
        head: row?.current_commit ?? null
      });
      return {
        workspaceId: slot.workspaceId,
        slot: slot.slot,
        state,
        lifecycle: lifecycle.lifecycle,
        executor_state: lifecycle.executor_state,
        healthy: lifecycle.healthy,
        idleMinutes: slot.idleMinutes,
        repository: repo ? `${repo.owner}/${repo.name}` : row?.repository ?? null,
        branch,
        head,
        requestedRef: row?.requested_ref ?? null,
        updatedAt: row?.updated_at ?? slot.lastActiveAt,
        next_step: lifecycle.next_step,
        allowedNextActions: lifecycle.allowedNextActions,
        durability: lifecycle.durability,
        task: task
          ? {
              id: task.id,
              state: task.state,
              goal: task.goal.length > 160 ? `${task.goal.slice(0, 157)}…` : task.goal,
              changedFiles: hints.changedFiles,
              checks: hints.checks,
              updatedAt: task.updated_at
            }
          : null
      };
    })
  };
}

export async function buildWorkspaceObserverDetail(env: Env, tenantId: string, workspaceId: string) {
  const row = await env.METADATA.prepare(
    'SELECT id, state, current_branch, current_commit FROM workspaces WHERE id = ?1 AND tenant_id = ?2 LIMIT 1'
  ).bind(workspaceId, tenantId).first<{
    id: string;
    state: string;
    current_branch: string | null;
    current_commit: string | null;
  }>();
  if (!row) return { workspaceId, available: false as const, reason: 'not_found' as const };

  const stub = workspaceOperations(env, workspaceId);
  const detail = await stub.getObserverSnapshot().catch(() => null);
  const d1Activity = await listWorkspaceActivity(env, tenantId, { workspaceId, limit: 60 });
  const tenantActivity = await listWorkspaceActivity(env, tenantId, { limit: 30 });

  if (!detail) {
    const lifecycle = describeWorkspaceLifecycle(row.state, {
      branch: row.current_branch,
      head: row.current_commit
    });
    return {
      workspaceId,
      available: false as const,
      reason: 'no_coordinator_record' as const,
      state: row.state,
      lifecycle: lifecycle.lifecycle,
      executor_state: lifecycle.executor_state,
      healthy: lifecycle.healthy,
      next_step: lifecycle.next_step,
      allowedNextActions: lifecycle.allowedNextActions,
      guidance: lifecycle.guidance,
      durability: lifecycle.durability,
      d1Activity,
      tenantActivity
    };
  }

  const state = detail.workspace.state;
  const lifecycle = describeWorkspaceLifecycle(state, {
    branch: detail.workspace.branch,
    head: detail.workspace.head
  });
  const mergedActivity = mergeActivity(detail.activity, d1Activity);
  const editActivity = mergedActivity.filter((row) => row.tool === 'forge_edit' && row.status === 'success');
  return {
    workspaceId,
    available: true as const,
    ...detail,
    lifecycle: lifecycle.lifecycle,
    executor_state: lifecycle.executor_state,
    healthy: lifecycle.healthy,
    next_step: lifecycle.next_step,
    allowedNextActions: lifecycle.allowedNextActions,
    guidance: lifecycle.guidance,
    durability: {
      ...lifecycle.durability,
      remote_branch: detail.workspace.branch ?? null,
      remote_head: detail.workspace.head ?? null,
      recent_forge_edit_successes: editActivity.length,
      edits_pending_in_executor: false,
      note:
        state === 'requested'
          ? 'No executor is loaded. Prior forge_edit commits are on GitHub; empty processes/logs do not mean lost work.'
          : 'forge_edit is remote-first. Command-created files remain executor-only until recreated with forge_edit.'
    },
    activity: mergedActivity,
    d1Activity,
    tenantActivity,
    ...(state === 'requested'
      ? {
          expected_empty_executor: true as const,
          expected_empty_processes: true as const,
          expected_empty_logs: true as const
        }
      : {})
  };
}

/** Attach after identical successful observer polls so agents stop waiting for a state change. */
export function observerRepeatDiagnostic(tool: string, priorIdenticalSuccesses: number): {
  stop_polling: true;
  repeatedIdenticalSuccesses: number;
  guidance: string;
  allowedNextActions: string[];
} | null {
  // prior count excludes the current call; >= 2 means this is at least the 3rd identical success.
  if (priorIdenticalSuccesses < 2) return null;
  const attempts = priorIdenticalSuccesses + 1;
  return {
    stop_polling: true,
    repeatedIdenticalSuccesses: attempts,
    guidance:
      `You have called ${tool} with these exact arguments ${attempts} times and received the same healthy receipt every time. ` +
      'Further identical observer polls will not change state. If lifecycle is lazy_control_plane / state is requested, ' +
      'proceed with forge_files_read or forge_edit now. Only poll forge_workspace_get when an execution tool returned FORGE_WORKSPACE_NOT_READY ' +
      'and lifecycle is executor_starting. Do not create a second workspace.',
    allowedNextActions: [...LAZY_REQUESTED_NEXT_ACTIONS]
  };
}

function mergeActivity(
  doActivity: Array<{ at: string; tool: string; status: 'success' | 'error'; durationMs: number; errorCode?: string }>,
  d1: Awaited<ReturnType<typeof listWorkspaceActivity>>
) {
  const seen = new Set<string>();
  const out: Array<{ at: string; tool: string; status: 'success' | 'error'; durationMs: number; errorCode?: string; source: 'durable' | 'd1' }> = [];
  for (const row of d1) {
    const key = `${row.occurredAt}:${row.tool}:${row.durationMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      at: row.occurredAt,
      tool: row.tool,
      status: row.status,
      durationMs: row.durationMs,
      errorCode: row.errorCode ?? undefined,
      source: 'd1'
    });
  }
  for (const row of doActivity) {
    const key = `${row.at}:${row.tool}:${row.durationMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...row, source: 'durable' });
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, 80);
}
