import { ForgeError, ids, type OperationId, type ProcessId } from '@forge/core';
import { assertCommandAllowed, classifyCommand, isAgentForgeBranch, nonInteractiveShellEnv } from '@forge/policy';
import type { NetworkPolicyMode, ProcessRecord, SandboxHandle, SandboxProvider } from '@forge/sandbox-core';

import type { ManagedProcessEntry, WorkspaceRuntimeRecord } from './index.js';

/** Schema-safe dependency state for strict MCP hosts that reject null. */
export type DependencyStateView = {
  status: 'unknown' | 'ready' | 'missing' | 'unusable';
  reason: string;
  lockfileHash?: string;
  installedAt?: string;
  usable: boolean;
};

export function dependencyStateView(
  state?: { lockfileHash: string; installedAt: string; usable: boolean } | null
): DependencyStateView {
  if (!state) {
    return { status: 'unknown', reason: 'not_observed', usable: false };
  }
  if (state.usable) {
    return {
      status: 'ready',
      reason: 'installed',
      lockfileHash: state.lockfileHash,
      installedAt: state.installedAt,
      usable: true
    };
  }
  return {
    status: 'unusable',
    reason: 'install_not_visible',
    lockfileHash: state.lockfileHash,
    installedAt: state.installedAt,
    usable: false
  };
}

export function managedProcessStatus(
  entry: ManagedProcessEntry
): 'running' | 'exited' | 'failed' | 'cancelled' {
  if (!entry.completedAt) return 'running';
  if (entry.exitCode === 0) return 'exited';
  if (entry.exitCode === 124) return 'cancelled';
  return 'failed';
}

export const LAZY_REQUESTED_NEXT_ACTIONS = [
  'forge_files_read',
  'forge_files_list',
  'forge_edit',
  'forge_shell',
  'forge_workspace_get'
] as const;

/** Host transport aborts near 60s; each wait observes at most this long. */
export const OBSERVATIONAL_WAIT_MS = 30_000;

/**
 * ChatGPT previously treated install start guidance that said
 * `timeout_ms >= 600000` as a single long wait. That exceeds the MCP transport
 * and contradicts forge_process_wait's 30s max — agents then restarted installs
 * or invented larger waits. One shared recipe only.
 */
export function observationalWaitNextStep(
  processId: string,
  options: { alreadyRunning?: boolean; suggestedTimeoutMs?: number } = {}
): string {
  const budget = options.suggestedTimeoutMs ?? OBSERVATIONAL_WAIT_MS;
  const prefix = options.alreadyRunning
    ? `An install is already running as ${processId}. Do not start another install. `
    : '';
  return (
    `${prefix}Call forge_process_wait with process_id ${processId} and timeout_ms at most ${budget}. ` +
    `If timedOut:true, call forge_process_wait again with the same process_id — each call only observes; ` +
    `never restart the process or raise the wait above ${budget}.`
  );
}

/** First-execution wake / mid-provision poll recipe. Avoids duplicate workspaces. */
export const EXECUTOR_PROVISIONING_NEXT_STEP =
  'Call forge_workspace_get; if state is still provisioning or bootstrapping, wait a few seconds and call forge_workspace_get again until ready, then retry the same execution tool. Do not create a second workspace.';


export function workspaceAllowedNextActions(record: WorkspaceRuntimeRecord): string[] {
  const active = Object.entries(record.processes).filter(([, entry]) => !entry.completedAt);
  if (active.length > 0) {
    return [
      'forge_process_wait',
      'forge_process_list',
      'forge_process_logs',
      'forge_process_stop'
    ];
  }
  const state = record.workspace.state;
  // Lazy create parks here with a GitHub branch and no executor. Agents that
  // only see forge_workspace_get treat this as a hang and never call the
  // GitHub-backed tools that already work.
  if (state === 'requested') {
    return [...LAZY_REQUESTED_NEXT_ACTIONS];
  }
  if (state === 'provisioning' || state === 'bootstrapping') {
    return ['forge_workspace_get'];
  }
  if (!['ready', 'busy'].includes(state)) {
    return ['forge_workspace_get'];
  }
  if (!isAgentForgeBranch(record.workspace.currentBranch)) {
    return [
      'forge_workspace_get',
      'forge_files_list'
    ];
  }
  const deps = dependencyStateView(record.dependencyState);
  if (deps.status !== 'ready') {
    return [
      'forge_deps_install',
      'forge_shell',
      'forge_workspace_get'
    ];
  }
  return [
    'forge_edit',
    'forge_shell',
    'forge_merge',
    'forge_workspace_get'
  ];
}

type HandleResolver = (record: WorkspaceRuntimeRecord, options?: { allowRecreate?: boolean }) => Promise<SandboxHandle>;
type BeginMutation = (record: WorkspaceRuntimeRecord, expectedRevision: number | undefined, idempotencyKey: string) => { operationId: OperationId; replay: boolean };

/** Owns managed command lifecycle and executor-local mutation receipts. */
export class ManagedProcesses {
  constructor(
    private readonly provider: SandboxProvider,
    private readonly resolveHandle: HandleResolver,
    private readonly beginMutation: BeginMutation
  ) {}

  async syncProcessLifecycle(
    record: WorkspaceRuntimeRecord,
    options: { finalize?: boolean } = {}
  ): Promise<{
    running: number;
    completed: number;
  }> {
    const finalize = options.finalize !== false;
    const handle = await this.provider.get(record.providerId);
    let running = 0;
    let completed = 0;
    for (const [id, entry] of Object.entries(record.processes)) {
      if (entry.completedAt) {
        completed += 1;
        if (
          finalize &&
          entry.mutatesFilesystem &&
          (entry.exitCode ?? 1) === 0 &&
          !entry.finalizedAt
        ) {
          await this.finalizeManagedProcess(record, handle, id as ProcessId, {
            id: id as ProcessId,
            providerProcessId: id,
            command: entry.command,
            cwd: '/workspace/repo',
            status: 'exited',
            startedAt: entry.startedAt,
            completedAt: entry.completedAt,
            exitCode: entry.exitCode ?? 0,
            mutatesFilesystem: true
          }).catch(() => undefined);
        }
        continue;
      }
      const { process: live, lookupFailed } = await this.lookupProcessWithRetry(handle, id as ProcessId);
      if (lookupFailed) {
        running += 1;
        continue;
      }
      if (!live) {
        entry.completedAt = new Date().toISOString();
        entry.exitCode = entry.exitCode ?? 1;
        completed += 1;
        continue;
      }
      if (live.status === 'running' || live.status === 'starting') {
        running += 1;
        continue;
      }
      entry.completedAt = live.completedAt ?? new Date().toISOString();
      entry.exitCode = live.exitCode ?? entry.exitCode;
      completed += 1;
      if (finalize && entry.mutatesFilesystem && (entry.exitCode ?? 1) === 0 && !entry.finalizedAt) {
        await this.finalizeManagedProcess(record, handle, id as ProcessId, live).catch(() => undefined);
      }
    }
    record.workspace.updatedAt = new Date().toISOString();
    return { running, completed };
  }

  private async setWorkspaceKeepAlive(record: WorkspaceRuntimeRecord, keepAlive: boolean): Promise<void> {
    const provider = this.provider;
    if (!provider.setKeepAlive) return;
    await provider.setKeepAlive(record.providerId, keepAlive).catch(() => undefined);
  }

  async startProcess(
    record: WorkspaceRuntimeRecord,
    input: {
      command: string;
      cwd: string;
      environment?: Record<string, string>;
      networkPolicy: NetworkPolicyMode;
      idempotencyKey: string;
      expectedRevision?: number;
      approved?: boolean;
    }
  ) {
    const decision = classifyCommand(input.command, input.networkPolicy);
    // Approved dependency installs must be allowed as managed processes. Blocking
    // them forced the timeout-conversion path, which restarted installs and left
    // a torn node_modules tree invisible to later shells.
    assertCommandAllowed(input.command, input.networkPolicy, input.approved ?? false);
    const operation = this.beginMutation(
      record,
      input.expectedRevision,
      input.idempotencyKey
    );
    if (operation.replay) {
      const replayed = this.replayManagedProcess(record, input.idempotencyKey, input.cwd, operation.operationId);
      if (replayed) return replayed;
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_CONFLICT',
        message: 'This process start was already accepted but its process id is no longer available; inspect forge_workspace_get and forge_process_list before retrying with a new idempotency key.',
        retryable: false,
        details: {
          idempotencyKey: input.idempotencyKey,
          operationId: operation.operationId,
          allowedNextActions: ['forge_workspace_get', 'forge_process_list', 'forge_operation_get']
        }
      });
    }
    const processId = ids.process();
    const startedAt = new Date().toISOString();
    const mutatesFilesystem = decision.classification !== 'read_only';
    // Keep the container awake for the whole mutation. Cloudflare sleep wipes
    // /workspace; without keepAlive a finished install can vanish before the
    // next shell command observes it.
    if (mutatesFilesystem) await this.setWorkspaceKeepAlive(record, true);
    const value = await (await this.resolveHandle(record, { allowRecreate: !mutatesFilesystem })).startProcess({
      processId,
      command: input.command,
      cwd: input.cwd,
      environment: nonInteractiveShellEnv(input.environment ?? {}),
      // Same session as forge_shell so later foreground commands share the
      // shell environment and always observe the process filesystem writes.
      sessionId: 'agent-default',
      networkPolicy: input.networkPolicy,
      autoCleanup: false,
      mutatesFilesystem
    });
    record.processes[processId] = {
      command: input.command,
      startedAt,
      mutatesFilesystem,
      executorCommit: record.executorCommit ?? record.workspace.currentCommit
    };
    record.idempotency[input.idempotencyKey] = {
      ...record.idempotency[input.idempotencyKey]!,
      processId
    };
    return {
      value: { ...value, mutatesFilesystem },
      replayed: false,
      idempotencyKey: input.idempotencyKey,
      originalOperationId: operation.operationId,
      workspaceId: record.workspace.id,
      branch: record.workspace.currentBranch,
      head: record.executorCommit ?? record.workspace.currentCommit,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: ['forge_process_wait', 'forge_process_logs', 'forge_process_list']
    };
  }

  private replayManagedProcess(
    record: WorkspaceRuntimeRecord,
    idempotencyKey: string,
    cwd: string,
    operationId: OperationId
  ) {
    const processId = record.idempotency[idempotencyKey]?.processId;
    if (!processId) return null;
    const entry = record.processes[processId];
    if (!entry) return null;
    const status = managedProcessStatus(entry);
    return {
      replay: true as const,
      replayed: true as const,
      idempotencyKey,
      originalOperationId: operationId,
      value: {
        id: processId,
        providerProcessId: processId,
        command: entry.command,
        cwd,
        status,
        startedAt: entry.startedAt,
        mutatesFilesystem: entry.mutatesFilesystem,
        ...(entry.completedAt ? { completedAt: entry.completedAt, exitCode: entry.exitCode ?? 1 } : {})
      },
      workspaceId: record.workspace.id,
      branch: record.workspace.currentBranch,
      head: entry.executorCommit ?? record.executorCommit ?? record.workspace.currentCommit,
      operationId,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: entry.completedAt
        ? ['forge_process_list', 'forge_process_logs', 'forge_shell']
        : ['forge_process_wait', 'forge_process_logs', 'forge_process_list']
    };
  }

  async processLogs(
    record: WorkspaceRuntimeRecord,
    processId: ProcessId,
    cursor?: string
  ) {
    const handle = await this.resolveHandle(record, { allowRecreate: false });
    const logs = await handle.readProcessLogs({
      processId,
      cursor,
      limitBytes: 200_000
    });
    const process = await handle.getProcess(processId);
    const entry = record.processes[processId];
    if (entry && process && !entry.completedAt && process.status !== 'running' && process.status !== 'starting') {
      entry.completedAt = process.completedAt ?? new Date().toISOString();
      entry.exitCode = process.exitCode ?? entry.exitCode;
      record.workspace.updatedAt = new Date().toISOString();
    }
    const status = process?.status
      ?? (entry ? managedProcessStatus(entry) : 'orphaned');
    const hasMore = Boolean(logs.nextCursor);
    return {
      data: logs.data,
      nextCursor: logs.nextCursor ?? null,
      hasMore,
      truncated: logs.truncated,
      status,
      exitCode: process?.exitCode ?? entry?.exitCode,
      completedAt: process?.completedAt ?? entry?.completedAt ?? null,
      mutatesFilesystem: entry?.mutatesFilesystem ?? process?.mutatesFilesystem ?? false,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: status === 'running' || status === 'starting'
        ? ['forge_process_wait', 'forge_process_logs', 'forge_process_list']
        : ['forge_process_list', 'forge_shell', 'forge_workspace_get']
    };
  }

  async processGet(record: WorkspaceRuntimeRecord, processId: ProcessId) {
    const handle = await this.resolveHandle(record, { allowRecreate: false });
    const process = await handle.getProcess(processId);
    if (!process) throw new ForgeError({ code: 'FORGE_PROCESS_NOT_FOUND', message: 'The managed process was not found in this workspace.', retryable: false, details: { processId } });
    const entry = record.processes[processId];
    if (entry && !entry.completedAt && process.status !== 'running' && process.status !== 'starting') {
      entry.completedAt = process.completedAt ?? new Date().toISOString();
      entry.exitCode = process.exitCode ?? entry.exitCode;
      record.workspace.updatedAt = new Date().toISOString();
    }
    const merged = {
      ...process,
      command: entry?.command || process.command,
      mutatesFilesystem: entry?.mutatesFilesystem ?? process.mutatesFilesystem,
      ...(entry?.completedAt
        ? { completedAt: entry.completedAt, exitCode: entry.exitCode ?? process.exitCode }
        : {})
    };
    return {
      workspaceId: record.workspace.id,
      process: merged,
      recorded: entry ?? null,
      dependencyState: dependencyStateView(record.dependencyState),
      workspaceRevision: record.workspace.revision,
      allowedNextActions: merged.status === 'running' || merged.status === 'starting'
        ? ['forge_process_wait', 'forge_process_logs', 'forge_process_stop']
        : ['forge_shell', 'forge_workspace_get']
    };
  }

  async processList(record: WorkspaceRuntimeRecord) {
    await this.syncProcessLifecycle(record);
    const processes = Object.entries(record.processes).map(([id, entry]) => ({
      id,
      command: entry.command,
      status: managedProcessStatus(entry),
      exitCode: entry.exitCode,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      mutatesFilesystem: entry.mutatesFilesystem
    }));
    return {
      workspaceId: record.workspace.id,
      processes,
      dependencyState: dependencyStateView(record.dependencyState),
      workspaceRevision: record.workspace.revision,
      allowedNextActions: workspaceAllowedNextActions(record)
    };
  }

  async operationGet(record: WorkspaceRuntimeRecord, operationId: OperationId) {
    // Sync provider process status before reporting, so a completed install is
    // not still described as active after a client disconnect.
    await this.syncProcessLifecycle(record).catch(() => undefined);
    const match = Object.entries(record.idempotency).find(([, value]) => value.operationId === operationId);
    if (!match) {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: 'No operation with that id is recorded for this workspace.',
        retryable: false,
        details: { operationId, allowedNextActions: ['forge_workspace_get', 'forge_process_list'] }
      });
    }
    const [idempotencyKey, entry] = match;
    const processId = entry.processId;
    const processEntry = processId ? record.processes[processId] : undefined;
    let status: 'accepted' | 'active' | 'completed' | 'failed' | 'cancelled' = 'accepted';
    if (processEntry) {
      const processStatus = managedProcessStatus(processEntry);
      status = processStatus === 'running'
        ? 'active'
        : processStatus === 'exited'
          ? 'completed'
          : processStatus === 'cancelled'
            ? 'cancelled'
            : 'failed';
    }
    return {
      workspaceId: record.workspace.id,
      operationId,
      idempotencyKey,
      replayed: false,
      originalOperationId: operationId,
      status,
      processId: processId ?? null,
      process: processEntry
        ? {
            id: processId,
            command: processEntry.command,
            status: managedProcessStatus(processEntry),
            exitCode: processEntry.exitCode,
            completedAt: processEntry.completedAt,
            mutatesFilesystem: processEntry.mutatesFilesystem
          }
        : null,
      dependencyState: dependencyStateView(record.dependencyState),
      workspaceRevision: record.workspace.revision,
      allowedNextActions: status === 'active'
        ? ['forge_process_wait', 'forge_process_list', 'forge_process_logs']
        : ['forge_workspace_get', 'forge_process_list', 'forge_shell']
    };
  }

  async processWait(record: WorkspaceRuntimeRecord, processId: ProcessId, timeoutMs?: number) {
    // Never replace an executor while waiting; this call is observational.
    const handle = await this.resolveHandle(record, { allowRecreate: false });
    // This method is reached through an HTTP tool call whose transport expires
    // at roughly 60 seconds. Keep a generous response/ingestion margin even
    // when an older client asks to wait for several minutes: waiting is
    // observational, so another short call is always safe.
    const requestedTimeoutMs = Math.max(250, Math.min(timeoutMs ?? 30_000, 30_000));
    let process: ProcessRecord;
    try {
      if (handle.processWait) {
        process = await handle.processWait({ processId, timeoutMs: requestedTimeoutMs });
      } else {
        const current = await handle.getProcess(processId);
        if (!current) throw new ForgeError({ code: 'FORGE_PROCESS_NOT_FOUND', message: 'The managed process was not found in this workspace.', retryable: false, details: { processId } });
        process = current;
      }
    } catch (error) {
      if (
        error instanceof ForgeError &&
        error.code === 'FORGE_COMMAND_TIMEOUT'
      ) {
        return this.processWaitTimedOut(record, handle, processId, requestedTimeoutMs);
      }
      throw error;
    }
    if (process.status === 'running' || process.status === 'starting') {
      // Provider returned a non-terminal process state without throwing; treat it as an
      // observational timeout so ChatGPT gets a steered next action.
      return this.processWaitTimedOut(record, handle, processId, requestedTimeoutMs, process);
    }
    await this.finalizeManagedProcess(record, handle, processId, process);
    const entry = record.processes[processId];
    return {
      timedOut: false as const,
      workspaceId: record.workspace.id,
      process: {
        ...process,
        mutatesFilesystem: entry?.mutatesFilesystem ?? process.mutatesFilesystem,
        ...(entry?.completedAt
          ? { completedAt: entry.completedAt, exitCode: entry.exitCode }
          : {})
      },
      dependencyState: dependencyStateView(record.dependencyState),
      finalLogCursor: null,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: ['forge_shell', 'forge_workspace_get', 'forge_process_logs'],
      next_step: entry?.mutatesFilesystem
        ? 'Process finished. Its filesystem changes remain only in this ephemeral executor session; use forge_edit to save deliberate changes to GitHub.'
        : 'Process finished. Continue with shell commands or forge_workspace_get.'
    };
  }

  private async processWaitTimedOut(
    record: WorkspaceRuntimeRecord,
    handle: SandboxHandle,
    processId: ProcessId,
    timeoutMs: number,
    known?: ProcessRecord | null
  ) {
    const process = known ?? await handle.getProcess(processId).catch(() => null);
    const entry = record.processes[processId];
    const suggestedTimeoutMs = 30_000;
    return {
      timedOut: true as const,
      workspaceId: record.workspace.id,
      process: {
        id: processId,
        providerProcessId: process?.providerProcessId ?? processId,
        command: entry?.command ?? process?.command ?? '',
        cwd: process?.cwd ?? '/workspace/repo',
        status: (process?.status ?? (entry && !entry.completedAt ? 'running' : 'orphaned')) as ProcessRecord['status'],
        pid: process?.pid,
        startedAt: entry?.startedAt ?? process?.startedAt ?? new Date().toISOString(),
        mutatesFilesystem: entry?.mutatesFilesystem ?? process?.mutatesFilesystem ?? false,
        ...(entry?.completedAt
          ? { completedAt: entry.completedAt, exitCode: entry.exitCode }
          : {})
      },
      dependencyState: dependencyStateView(record.dependencyState),
      finalLogCursor: null,
      suggestedTimeoutMs,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: ['forge_process_wait', 'forge_process_logs', 'forge_process_list'],
      next_step: `Process ${processId} is still running after this bounded observation. Call forge_process_wait again with the same process_id; each call observes for at most ${suggestedTimeoutMs}ms and never restarts or kills the process.`
    };
  }

  async processCancel(
    record: WorkspaceRuntimeRecord,
    processId: ProcessId,
    expectedRevision: number | undefined,
    idempotencyKey: string
  ) {
    if (!record.processes[processId]) {
      throw new ForgeError({
        code: 'FORGE_PROCESS_NOT_FOUND',
        message: 'The process is not owned by this workspace.',
        retryable: false,
        details: { processId }
      });
    }
    const operation = this.beginMutation(record, expectedRevision, idempotencyKey);
    if (operation.replay) {
      return {
        replay: true,
        replayed: true,
        idempotencyKey,
        originalOperationId: operation.operationId,
        workspaceId: record.workspace.id,
        processId,
        operationId: operation.operationId,
        workspaceRevision: record.workspace.revision,
        allowedNextActions: ['forge_process_list', 'forge_workspace_get']
      };
    }
    const handle = await this.resolveHandle(record);
    let process: { status: string; exitCode?: number; completedAt?: string };
    if (handle.processCancel) {
      const result = await handle.processCancel(processId);
      process = result;
    } else {
      await handle.stopProcess(processId);
      process = { status: 'cancelled', exitCode: 124, completedAt: new Date().toISOString() };
    }
    const entry = record.processes[processId];
    if (entry) {
      entry.completedAt = process.completedAt;
      entry.exitCode = process.exitCode;
    }
    delete record.processes[processId];
    return {
      workspaceId: record.workspace.id,
      processId,
      cancelled: true,
      replayed: false,
      idempotencyKey,
      originalOperationId: operation.operationId,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: ['forge_process_list', 'forge_workspace_get', 'forge_shell']
    };
  }

  async stopProcess(
    record: WorkspaceRuntimeRecord,
    processId: ProcessId,
    expectedRevision: number | undefined,
    idempotencyKey: string
  ) {
    if (!record.processes[processId]) {
      throw new ForgeError({
        code: 'FORGE_PROCESS_NOT_FOUND',
        message: 'The process is not owned by this workspace.',
        retryable: false,
        details: { processId }
      });
    }
    const operation = this.beginMutation(record, expectedRevision, idempotencyKey);
    if (operation.replay) {
      return {
        replay: true,
        replayed: true,
        idempotencyKey,
        originalOperationId: operation.operationId,
        workspaceId: record.workspace.id,
        processId,
        operationId: operation.operationId,
        workspaceRevision: record.workspace.revision,
        allowedNextActions: ['forge_process_list', 'forge_workspace_get']
      };
    }
    await (await this.resolveHandle(record)).stopProcess(processId);
    const entry = record.processes[processId];
    if (entry) {
      entry.completedAt = new Date().toISOString();
      entry.exitCode = 0;
    }
    delete record.processes[processId];
    return {
      workspaceId: record.workspace.id,
      processId,
      stopped: true,
      replayed: false,
      idempotencyKey,
      originalOperationId: operation.operationId,
      operationId: operation.operationId,
      workspaceRevision: record.workspace.revision,
      allowedNextActions: ['forge_process_list', 'forge_workspace_get', 'forge_shell']
    };
  }

  private async lookupProcessWithRetry(
    handle: SandboxHandle,
    processId: ProcessId
  ): Promise<{ process: ProcessRecord | null; lookupFailed: boolean }> {
    let lookupFailed = false;
    let process: ProcessRecord | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        process = await handle.getProcess(processId);
        lookupFailed = false;
        if (process) return { process, lookupFailed };
      } catch {
        lookupFailed = true;
        process = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { process, lookupFailed };
  }

  async adoptOrReap(record: WorkspaceRuntimeRecord, handle: SandboxHandle): Promise<void> {
    for (const [id, entry] of Object.entries(record.processes)) {
      if (entry.completedAt && entry.finalizedAt) continue;
      const { process: live, lookupFailed } = await this.lookupProcessWithRetry(handle, id as ProcessId);
      if (lookupFailed) {
        // Provider blip: keep the tracked process live until a later lookup.
        continue;
      }
      if (!live) {
        // Confirmed missing after retries. Adopt as exited, but do not pretend
        // a successful mutating install completed.
        if (!entry.completedAt) {
          entry.completedAt = new Date().toISOString();
          entry.exitCode = entry.exitCode ?? 1;
        }
        continue;
      }
      if (live.status === 'running' || live.status === 'starting') continue;
      entry.completedAt = live.completedAt ?? entry.completedAt ?? new Date().toISOString();
      entry.exitCode = live.exitCode ?? entry.exitCode;
      if (entry.mutatesFilesystem && (entry.exitCode ?? 1) === 0 && !entry.finalizedAt) {
        await this.finalizeManagedProcess(record, handle, id as ProcessId, live).catch(() => undefined);
      }
    }
    record.workspace.updatedAt = new Date().toISOString();
  }

  /**
   * After a managed process exits, prove dependency visibility inside the
   * same executor session. This never publishes repository files; only
   * forge_edit makes durable GitHub changes.
   */
  private async finalizeManagedProcess(
    record: WorkspaceRuntimeRecord,
    handle: SandboxHandle,
    processId: ProcessId,
    process: ProcessRecord
  ): Promise<void> {
    const entry = record.processes[processId];
    if (!entry) return;
    const terminal = process.status !== 'running' && process.status !== 'starting';
    if (!terminal) return;
    if (!entry.completedAt) {
      entry.completedAt = process.completedAt ?? new Date().toISOString();
      entry.exitCode = process.exitCode ?? entry.exitCode;
    }
    if (!entry.mutatesFilesystem || (entry.exitCode ?? process.exitCode ?? 1) !== 0) {
      record.workspace.updatedAt = new Date().toISOString();
      return;
    }
    if (entry.finalizedAt && record.dependencyState?.usable !== false) {
      record.workspace.updatedAt = new Date().toISOString();
      return;
    }

    const decision = classifyCommand(entry.command, 'package_install');
    const isNodeInstall = decision.classification === 'dependency_install'
      && /(^|\s)(npm|pnpm|yarn|bun)\s+/i.test(entry.command);
    const isPythonInstall = decision.classification === 'dependency_install'
      && /(^|\s)(pip|uv)\s+install(\s|$)/i.test(entry.command);

    // Flush and prove the install/mutation is visible through the same session
    // foreground shells use (`agent-default`), before we publish success.
    const visibility = await handle.exec({
      command: [
        'sync',
        'if [ -d node_modules ] || [ -f .pnp.cjs ] || [ -f .pnp.js ]; then echo "FORGE_NODE_MODULES=present"; else echo "FORGE_NODE_MODULES=absent"; fi',
        'if [ -d .venv ] || [ -d venv ] || ls -d site-packages >/dev/null 2>&1; then echo "FORGE_PYTHON_ENV=present"; else echo "FORGE_PYTHON_ENV=absent"; fi',
        'if [ -f pnpm-lock.yaml ] || [ -f package-lock.json ] || [ -f yarn.lock ] || [ -f bun.lock ] || [ -f requirements.txt ] || [ -f uv.lock ]; then echo "FORGE_LOCKFILE=present"; fi'
      ].join('; '),
      cwd: '/workspace/repo',
      timeoutMs: 30_000,
      outputLimitBytes: 4_000,
      sessionId: 'agent-default',
      networkPolicy: 'deny_all'
    }).catch(() => null);

    if (decision.classification === 'dependency_install') {
      let usable = Boolean(visibility && visibility.exitCode === 0);
      if (isNodeInstall) {
        usable = Boolean(
          visibility &&
          visibility.exitCode === 0 &&
          visibility.stdout.includes('FORGE_NODE_MODULES=present')
        );
      } else if (isPythonInstall) {
        // Python installs do not create node_modules; trust a successful sync
        // plus either a virtualenv marker or lock/requirements presence.
        usable = Boolean(
          visibility &&
          visibility.exitCode === 0 &&
          (
            visibility.stdout.includes('FORGE_PYTHON_ENV=present') ||
            visibility.stdout.includes('FORGE_LOCKFILE=present')
          )
        );
      }
      const lockfileHash = await handle.exec({
        command: 'sha256sum pnpm-lock.yaml package-lock.json yarn.lock bun.lock uv.lock requirements.txt 2>/dev/null | head -1 | cut -d" " -f1 || echo none',
        cwd: '/workspace/repo',
        timeoutMs: 10_000,
        outputLimitBytes: 1_000,
        sessionId: 'agent-default',
        networkPolicy: 'deny_all'
      }).then((result) => result.stdout.trim() || 'none').catch(() => 'none');
      record.dependencyState = {
        lockfileHash,
        installedAt: entry.completedAt,
        usable
      };
      if (!usable) {
        record.workspace.updatedAt = new Date().toISOString();
        throw new ForgeError({
          code: 'FORGE_PROVIDER_UNAVAILABLE',
          message: 'Managed dependency install exited successfully but the installed package tree is not visible to the workspace shell.',
          retryable: true,
          details: {
            processId,
            visibility: visibility
              ? { exitCode: visibility.exitCode, stdout: visibility.stdout.slice(0, 1_000), stderr: visibility.stderr.slice(0, 1_000) }
              : null
          }
        });
      }
    }

    entry.finalizedAt = new Date().toISOString();
    record.workspace.updatedAt = new Date().toISOString();
  }

}
