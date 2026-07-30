import { ForgeError } from './errors';
import type { WorkspaceLifecycleState } from './workspace';

const transitions: Record<WorkspaceLifecycleState, readonly WorkspaceLifecycleState[]> = {
  requested: ['provisioning', 'destroying', 'failed'],
  provisioning: ['bootstrapping', 'failed', 'destroying'],
  bootstrapping: ['ready', 'failed', 'destroying'],
  ready: ['busy', 'destroying', 'failed'],
  busy: ['ready', 'destroying', 'failed'],
  failed: ['destroying'],
  destroying: ['destroyed', 'failed'],
  destroyed: []
};

export function assertWorkspaceTransition(from: WorkspaceLifecycleState, to: WorkspaceLifecycleState): void {
  if (!transitions[from].includes(to)) {
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_CONFLICT',
      message: `Workspace cannot transition from ${from} to ${to}.`,
      retryable: false,
      details: { from, to }
    });
  }
}

export function nextRevision(current: number, expected?: number): number {
  if (expected !== undefined && expected !== current) {
    throw new ForgeError({
      code: 'FORGE_STALE_REVISION',
      message: `Expected workspace revision ${expected}, but current revision is ${current}.`,
      retryable: true,
      details: { expected, current }
    });
  }
  return current + 1;
}
