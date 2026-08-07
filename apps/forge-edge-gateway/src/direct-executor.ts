import { ForgeError, toForgeError } from '@forge/core';

// Keep the first direct-chat turn short. The provisioning workflow continues
// privately after this budget; the caller receives a durable branch-addressed
// status receipt instead of holding an MCP turn open for container startup.
export const DIRECT_EXECUTOR_STARTUP_BUDGET_MS = 5_000;
export const DIRECT_EXECUTOR_POLL_MS = 750;

type DirectExecutorState = {
  state: string;
};

type WaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function isDirectExecutorStartupPending(error: unknown): boolean {
  try {
    const forge = toForgeError(error);
    return forge.code === 'FORGE_WORKSPACE_NOT_READY'
      && forge.details?.direct_executor_startup === 'pending';
  } catch {
    return false;
  }
}

const terminalStates = new Set(['failed', 'destroyed', 'destroying']);

function isWorkspaceNotReady(error: unknown): boolean {
  try {
    return toForgeError(error).code === 'FORGE_WORKSPACE_NOT_READY';
  } catch {
    return false;
  }
}

function directStartupError(state: string, timedOut: boolean): ForgeError {
  return new ForgeError({
    code: 'FORGE_WORKSPACE_NOT_READY',
    message: timedOut
      ? 'Forge could not start the private executor within this request. No command ran. Retry the same action with the same repository and branch; Forge will resume the existing startup.'
      : `Forge could not start the private executor for this repository branch (${state}). No command ran. Retry the same action; Forge will create a fresh executor if needed.`,
    retryable: true,
    details: {
      allowedNextActions: ['forge_run', 'forge_screenshot'],
      direct_executor_startup: timedOut ? 'pending' : 'failed'
    }
  });
}

/**
 * Keep executor startup inside a direct-chat action. The legacy coordinator
 * deliberately returns a lazy `FORGE_WORKSPACE_NOT_READY` response for agent
 * callers; ordinary chat must absorb that state transition instead of being
 * asked to discover and poll the private lifecycle.
 */
export async function waitForDirectExecutorReady(
  start: () => Promise<void>,
  readState: () => Promise<DirectExecutorState | undefined>,
  options: WaitOptions = {}
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DIRECT_EXECUTOR_STARTUP_BUDGET_MS;
  const pollMs = options.pollMs ?? DIRECT_EXECUTOR_POLL_MS;
  const deadline = now() + timeoutMs;
  let state = 'requested';

  for (;;) {
    try {
      await start();
      return;
    } catch (error) {
      if (!isWorkspaceNotReady(error)) throw error;
    }

    const observed = await readState();
    state = observed?.state ?? state;
    if (state === 'ready' || state === 'busy') return;
    if (terminalStates.has(state)) throw directStartupError(state, false);
    if (now() >= deadline) throw directStartupError(state, true);
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}
