import { ForgeError, ids, type ProjectId, type TenantId } from '@forge/core';
import type { ForgeToolHandlers } from '@forge/mcp-core';
import { D1TaskStore } from '@forge/metadata-d1';
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
import type { Env } from '../env';
import { resolveWorkspaceId } from '../workspace-resolve';
import { slotTtlMs } from '../capacity';
import { listAuthorizedRepositories, repositoryAccessDiagnosis } from '../github';
import { listDeferredActionsForWorkspace } from '../deferred-actions';
import { hoistUniformFields } from '../uniform-fields';
import { authorizedCoordinator, text, number, optionalNumber, asRecord, workspaceAddress, hasWorkspaceAddress } from './helpers';
import type { TaskHandlerDependencies } from './types';

type WorkflowTool = 'forge_repository_list' | 'forge_task_create' | 'forge_task_get' | 'forge_task_list' | 'forge_task_update';

/** Focused task workflows behind the ForgeToolHandlers seam. */
export function taskToolHandlers(env: Env, deps: TaskHandlerDependencies): Pick<ForgeToolHandlers, WorkflowTool> {
  return {
      forge_repository_list: async () => {
        const identity = deps.identity();
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
        const identity = deps.identity();
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
        return {
          task_id: task.id,
          state: task.state,
          revision: task.revision,
          container_used: false,
          next_step:
            'Keep this task_id for the session. Pass it to forge_task_get mode:resume, forge_task_update, and forge_merge — do not discard it when context compresses.'
        };
      },
      forge_task_get: async (input) => {
        const identity = deps.identity();
        const task = await deps.loadTask(text(input.task_id) as TaskId);
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
                ? `An idle workspace is reclaimed after ~${ttlMinutes} minutes of inactivity. Durable edits are already committed by forge_edit; call forge_task_update before then, or send any tool call to reset the idle clock.`
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
              dependencyState: stateRecord.dependencyState ?? null,
              activeProcessIds: stateRecord.activeProcessIds ?? [],
              processes: stateRecord.processes ?? [],
              allowedNextActions: stateRecord.allowedNextActions ?? [],
              next_step: stateRecord.next_step ?? null
            };
            const status = await workspace.gitStatus();
            gitSummary = {
              clean: status.clean,
              branch: status.branch
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
        const identity = deps.identity();
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
        const identity = deps.identity();
        const store = new D1TaskStore(env.METADATA);
        let task = await deps.loadTask(text(input.task_id) as TaskId);
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
        await deps.recordAudit(
          'task.finish',
          identity.tenantId,
          {
            taskId: updated.id,
            outcome: updated.state,
            forced: force,
            note: input.note ? text(input.note) : undefined,
            remoteBranchSha: updated.remoteBranchSha,
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

  };
}
