import type { Task, TaskHandoff } from './task';

/**
 * A compact, portable summary of a durable task. This is the single most
 * important reconnect capability: it must give a fresh ChatGPT turn enough
 * context to resume WITHOUT replaying the whole session.
 *
 * It deliberately excludes full source files, complete command logs, complete
 * diffs, secrets and raw environment variables. Those remain retrievable
 * separately as artifacts.
 */
export interface TaskSummary {
  taskId: string;
  goal: string;
  decisions: string[];
  nonGoals: string[];
  baseRef: string;
  branch: string | null;
  workspaceState: 'none' | 'attached';
  previewState: 'none' | 'open';
  filesRead: string[];
  filesChanged: string[];
  checks: Array<{ command: string; status: string }>;
  evidence: string[];
  outstanding: string[];
  handoff?: TaskHandoff;
  knownLimitations: string[];
  nextRecommendedAction: string;
  state: Task['state'];
  updatedAt: string;
}

/** Patterns that must never appear verbatim in a compact summary. */
const SECRET_PATTERNS: RegExp[] = [
  /gh[posru]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /-----BEGIN[ A-Z]*PRIVATE KEY-----/g,
  /\b[A-Za-z0-9._%+-]+:[^@\s/]{6,}@/g // credentials embedded in URLs
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[redacted]'), value);
}

const MAX_LIST = 40;

function boundedRedacted(values: string[]): string[] {
  return values.slice(0, MAX_LIST).map(redactSecrets);
}

/**
 * Derive the next recommended action deterministically from task state. The
 * client remains the reasoning agent; this is only a cheap hint.
 */
function recommendNextAction(task: Task): string {
  switch (task.state) {
    case 'planning':
      return 'Generate bounded repository context and read the likely paths before editing.';
    case 'ready':
      return 'Create one workspace and begin the smallest coherent patch.';
    case 'coding':
      return task.changedFiles.length > 0
        ? 'Run the narrowest targeted checks for the changed paths.'
        : 'Read the target files, then apply a coherent patch.';
    case 'validating':
      return 'Inspect failing checks; widen validation only if narrow checks pass.';
    case 'previewing':
      return 'Open a browser session and capture phone and desktop evidence.';
    case 'reviewing':
      return 'Inspect the raw outgoing diff before any Git mutation.';
    case 'awaiting-approval':
      return 'Wait for the user approval, then push the forge/ branch.';
    case 'complete':
      return 'Task complete. Destroy the workspace and confirm preview revocation.';
    case 'failed':
      return 'Diagnose the recorded failure; resume from coding or cancel.';
    case 'cancelled':
      return 'Task cancelled. No further action.';
  }
}

export function deriveLimitations(task: Task): string[] {
  const limitations: string[] = [];
  const failing = task.checks.filter((c) => c.status === 'failed' || c.status === 'partial');
  if (failing.length > 0) {
    limitations.push(`${failing.length} check(s) not fully passing.`);
  }
  if (task.changedFiles.length > 0 && task.checks.length === 0) {
    limitations.push('Changes exist but no checks have been recorded.');
  }
  if (task.changedFiles.length > 0 && !task.latestDiffHash && task.state === 'reviewing') {
    limitations.push('Raw diff not yet inspected; push is unsafe until it is.');
  }
  if (task.changedFiles.length > 0 && !task.remoteBranchSha) {
    limitations.push('Changed files exist but the feature branch is not verified on origin.');
  }
  return limitations;
}

/**
 * Whether forge_task_finish should refuse `outcome: 'complete'` for this task
 * without an explicit force override. Mirrors deriveLimitations but only the
 * subset that means "this was not actually verified/landed" rather than
 * merely informational.
 */
export function hasBlockingCompletionGaps(task: Task): string[] {
  const blocking: string[] = [];
  const failing = task.checks.filter((c) => c.status === 'failed' || c.status === 'partial');
  if (failing.length > 0) {
    blocking.push(`${failing.length} check(s) recorded as failed or partial.`);
  }
  if (task.changedFiles.length > 0 && task.checks.length === 0) {
    blocking.push('Changes exist but no checks have been recorded.');
  }
  if (task.changedFiles.length > 0 && !task.remoteBranchSha) {
    blocking.push('Changed files exist but the feature branch is not verified on origin (remoteBranchSha missing).');
  }
  if (task.outstanding.length > 0) {
    blocking.push(`${task.outstanding.length} outstanding item(s) still recorded.`);
  }
  return blocking;
}

export function summarizeTask(task: Task): TaskSummary {
  return {
    taskId: task.id,
    goal: redactSecrets(task.goal),
    decisions: boundedRedacted(task.decisions),
    nonGoals: boundedRedacted(task.nonGoals),
    baseRef: task.baseRef,
    branch: task.branch ?? null,
    workspaceState: task.workspaceId ? 'attached' : 'none',
    previewState: task.previewId ? 'open' : 'none',
    filesRead: boundedRedacted(task.filesRead.map((f) => f.path)),
    filesChanged: boundedRedacted(task.changedFiles),
    checks: task.checks.slice(0, MAX_LIST).map((c) => ({
      command: redactSecrets(c.command),
      status: c.status
    })),
    evidence: task.evidenceIds.slice(0, MAX_LIST),
    outstanding: boundedRedacted(task.outstanding),
    handoff: task.handoff,
    knownLimitations: deriveLimitations(task),
    nextRecommendedAction: recommendNextAction(task),
    state: task.state,
    updatedAt: task.updatedAt
  };
}
