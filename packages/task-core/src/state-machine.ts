import { ForgeError } from '@forge/core';
import type { TaskState } from './task';

/**
 * Task lifecycle transitions. Coding work loops between the working states;
 * the three terminal states (complete, failed, cancelled) are absorbing.
 */
const transitions: Record<TaskState, readonly TaskState[]> = {
  planning: ['ready', 'coding', 'cancelled', 'failed'],
  ready: ['coding', 'cancelled', 'failed'],
  coding: ['validating', 'previewing', 'reviewing', 'awaiting-approval', 'coding', 'cancelled', 'failed'],
  validating: ['coding', 'previewing', 'reviewing', 'awaiting-approval', 'failed', 'cancelled'],
  previewing: ['coding', 'validating', 'reviewing', 'awaiting-approval', 'failed', 'cancelled'],
  reviewing: ['coding', 'validating', 'previewing', 'awaiting-approval', 'complete', 'failed', 'cancelled'],
  'awaiting-approval': ['reviewing', 'coding', 'complete', 'failed', 'cancelled'],
  complete: [],
  failed: ['coding', 'cancelled'],
  cancelled: []
};

export function isTerminalTaskState(state: TaskState): boolean {
  return transitions[state].length === 0;
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (from === to) return;
  if (!transitions[from].includes(to)) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `Task cannot transition from ${from} to ${to}.`,
      retryable: false,
      details: { from, to }
    });
  }
}
