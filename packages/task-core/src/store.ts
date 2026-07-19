import { ForgeError } from '@forge/core';
import type { TenantId } from '@forge/core';
import { assertTaskTransition } from './state-machine';
import type { Task, TaskId, TaskState } from './task';

/**
 * A durable task store. The interface is intentionally small; a D1-backed
 * implementation lives in @forge/metadata-d1 and mirrors these semantics.
 */
export interface TaskStore {
  put(task: Task): Promise<void>;
  get(id: TaskId): Promise<Task | null>;
  list(tenantId: TenantId, opts?: { state?: TaskState; limit?: number }): Promise<Task[]>;
}

/** Owner identity carried on every request, checked before any task is returned. */
export interface TaskOwner {
  tenantId: TenantId;
}

/**
 * A patch applied to a task on the server. Only the durable, resume-relevant
 * fields are mutable; identity and creation metadata are not.
 */
export interface TaskPatch {
  state?: TaskState;
  decisions?: string[];
  nonGoals?: string[];
  likelyPaths?: string[];
  branch?: string;
  workspaceId?: Task['workspaceId'];
  previewId?: Task['previewId'];
  addProcessIds?: Task['processIds'];
  addBrowserSessionIds?: string[];
  addFilesRead?: Task['filesRead'];
  addChangedFiles?: string[];
  addChecks?: Task['checks'];
  addEvidenceIds?: Task['evidenceIds'];
  latestDiffHash?: string;
  outstanding?: string[];
}

function uniquePush<T>(base: readonly T[], additions: readonly T[] | undefined, key: (v: T) => string): T[] {
  if (!additions || additions.length === 0) return [...base];
  const seen = new Set(base.map(key));
  const result = [...base];
  for (const addition of additions) {
    const k = key(addition);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(addition);
    }
  }
  return result;
}

/**
 * Apply a patch to a task purely (no I/O), validating the state transition and
 * bumping the revision. Callers persist the returned task through the store.
 */
export function applyTaskPatch(task: Task, patch: TaskPatch, at: string, expectedRevision?: number): Task {
  if (expectedRevision !== undefined && expectedRevision !== task.revision) {
    throw new ForgeError({
      code: 'FORGE_STALE_REVISION',
      message: `Expected task revision ${expectedRevision}, but current revision is ${task.revision}.`,
      retryable: true,
      details: { expected: expectedRevision, current: task.revision }
    });
  }
  if (patch.state) assertTaskTransition(task.state, patch.state);

  return {
    ...task,
    state: patch.state ?? task.state,
    decisions: patch.decisions ?? task.decisions,
    nonGoals: patch.nonGoals ?? task.nonGoals,
    likelyPaths: patch.likelyPaths ?? task.likelyPaths,
    branch: patch.branch ?? task.branch,
    workspaceId: patch.workspaceId ?? task.workspaceId,
    previewId: patch.previewId ?? task.previewId,
    processIds: uniquePush(task.processIds, patch.addProcessIds, (v) => v),
    browserSessionIds: uniquePush(task.browserSessionIds, patch.addBrowserSessionIds, (v) => v),
    filesRead: uniquePush(task.filesRead, patch.addFilesRead, (v) => v.path),
    changedFiles: uniquePush(task.changedFiles, patch.addChangedFiles, (v) => v),
    checks: uniquePush(task.checks, patch.addChecks, (v) => `${v.command}@${v.ranAt}`),
    evidenceIds: uniquePush(task.evidenceIds, patch.addEvidenceIds, (v) => v),
    latestDiffHash: patch.latestDiffHash ?? task.latestDiffHash,
    outstanding: patch.outstanding ?? task.outstanding,
    revision: task.revision + 1,
    updatedAt: at
  };
}

/** Enforce tenant ownership; throws rather than leaking another tenant's task. */
export function assertTaskOwnership(task: Task, owner: TaskOwner): void {
  if (task.tenantId !== owner.tenantId) {
    throw new ForgeError({
      code: 'FORGE_PERMISSION_DENIED',
      message: 'Task does not belong to the requesting tenant.',
      retryable: false
    });
  }
}

/** In-memory store for tests and the local single-owner deployment. */
export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();

  async put(task: Task): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }

  async get(id: TaskId): Promise<Task | null> {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : null;
  }

  async list(tenantId: TenantId, opts?: { state?: TaskState; limit?: number }): Promise<Task[]> {
    const limit = opts?.limit ?? 50;
    return Array.from(this.tasks.values())
      .filter((t) => t.tenantId === tenantId && (!opts?.state || t.state === opts.state))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map((t) => structuredClone(t));
  }
}
