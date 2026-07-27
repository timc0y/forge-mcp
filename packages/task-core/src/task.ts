import type {
  ArtifactId,
  PreviewId,
  ProcessId,
  ProjectId,
  TaskId,
  TenantId,
  WorkspaceId
} from '@forge/core';

export type { TaskId };

/**
 * A Task is a durable coding-session record that lives above the temporary
 * workspace. It survives MCP reconnects, ChatGPT context compression, container
 * sleep, browser closure, process failure and client reconnection.
 *
 * A Task is NOT a workspace. The workspace is disposable compute; the Task is
 * the durable memory that lets a fresh ChatGPT turn resume coherent work.
 */

/**
 * Recommended lifecycle states. Ordering is not strictly linear — a task may
 * loop between coding, validating, previewing and reviewing before completion.
 */
export type TaskState =
  | 'planning'
  | 'ready'
  | 'coding'
  | 'validating'
  | 'previewing'
  | 'reviewing'
  | 'awaiting-approval'
  | 'complete'
  | 'failed'
  | 'cancelled';

export const TASK_STATES: readonly TaskState[] = [
  'planning',
  'ready',
  'coding',
  'validating',
  'previewing',
  'reviewing',
  'awaiting-approval',
  'complete',
  'failed',
  'cancelled'
];

/** A check that was run against the workspace and its recorded outcome. */
export interface TaskCheck {
  command: string;
  cwd: string;
  status: 'passed' | 'failed' | 'partial' | 'skipped';
  /** Artifact id holding the full log; the summary never inlines it. */
  logArtifactId?: ArtifactId;
  ranAt: string;
}

/** A repository path the client has already read, with the revision it saw. */
export interface TaskFileRead {
  path: string;
  /** Content hash observed at read time, for conflict-safe editing later. */
  sha?: string;
  readAt: string;
}

export interface RepositoryRef {
  provider: 'github';
  owner: string;
  name: string;
}

/** Structured handoff note saved by an agent to allow a fresh session to pick up work. */
export interface TaskHandoff {
  summary: string;
  nextSteps: string[];
  keyLearnings?: string[];
  modifiedFiles?: string[];
  blockedBy?: string;
  createdAt: string;
  authorAgent?: string;
}

export interface Task {
  id: TaskId;
  tenantId: TenantId;
  projectId: ProjectId;
  repository: RepositoryRef;
  /** The immutable base reference the task branched from. */
  baseRef: string;
  goal: string;
  /** Durable decisions that must survive context compression. */
  decisions: string[];
  nonGoals: string[];
  likelyPaths: string[];
  filesRead: TaskFileRead[];
  /** The forge/ branch this task writes to, once created. */
  branch?: string;
  workspaceId?: WorkspaceId;
  processIds: ProcessId[];
  previewId?: PreviewId;
  browserSessionIds: string[];
  changedFiles: string[];
  checks: TaskCheck[];
  evidenceIds: ArtifactId[];
  /** Hash of the latest inspected raw diff, for push-time safety. */
  latestDiffHash?: string;
  /** ISO timestamp when the feature branch was verified on origin (ls-remote). */
  remoteBranchSha?: string;
  /** ISO timestamp when work was staged for deferred review (forge/staged). */
  submittedAt?: string;
  /** @deprecated Use remoteBranchSha — kept for older task documents. */
  pushedAt?: string;
  /** Structured handoff note saved by an agent to allow a fresh session to resume. */
  handoff?: TaskHandoff;
  state: TaskState;
  outstanding: string[];
  /** Optimistic-concurrency guard shared with the durable store. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Fields a client may supply when starting a durable task. */
export interface TaskStartInput {
  tenantId: TenantId;
  projectId: ProjectId;
  repository: RepositoryRef;
  baseRef: string;
  goal: string;
  decisions?: string[];
  nonGoals?: string[];
  likelyPaths?: string[];
}

export function createTask(id: TaskId, at: string, input: TaskStartInput): Task {
  return {
    id,
    tenantId: input.tenantId,
    projectId: input.projectId,
    repository: input.repository,
    baseRef: input.baseRef,
    goal: input.goal,
    decisions: input.decisions ?? [],
    nonGoals: input.nonGoals ?? [],
    likelyPaths: input.likelyPaths ?? [],
    filesRead: [],
    processIds: [],
    browserSessionIds: [],
    changedFiles: [],
    checks: [],
    evidenceIds: [],
    state: 'planning',
    outstanding: [],
    revision: 1,
    createdAt: at,
    updatedAt: at
  };
}
