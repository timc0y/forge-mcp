import { DurableObject } from 'cloudflare:workers';
import {
  ForgeApplicationService,
  dependencyStateView,
  managedProcessStatus,
  workspaceAllowedNextActions,
  type CreateWorkspaceInput,
  type WorkspaceRuntimeRecord
} from '@forge/application';
import { ForgeError, nextRevision, type OperationId, type ProcessId } from '@forge/core';
import { D1MetadataStore } from '@forge/metadata-d1';
import type { NetworkPolicyMode } from '@forge/sandbox-core';
import { CloudflareSandboxProvider } from '@forge/sandbox-cloudflare';
import { branchPolicyFor, classifyCommand, isAgentForgeBranch, nonInteractiveShellEnv } from '@forge/policy';
import type { Env } from './env';
import { repositoryCloneSource } from './github';

const RECORD_KEY = 'workspace-runtime';
// Legacy key from a removed mutation-lease mechanism; still cleared on destroy.
const LEASE_KEY = 'mutation-lease';
// How long a healthy checkout probe result stays trusted before repoRecord()
// re-runs the `test -d .git` container round-trip. During bursts of repo-scoped
// tool calls this collapses the redundant PRE-probe; the downstream self-heal
// still fires if a checkout vanishes within the window.
const CHECKOUT_PROBE_TTL_MS = 60_000;

function nextStepForWorkspace(
  record: WorkspaceRuntimeRecord,
  allowedNextActions: string[]
): string {
  const state = record.workspace.state;
  if (state === 'requested') {
    return 'GitHub branch is ready. Use forge_files_read and forge_edit now; the first forge_shell starts the ephemeral executor.';
  }
  if (state === 'provisioning' || state === 'bootstrapping') {
    return 'The ephemeral executor is still starting. Retry forge_workspace_get until state is ready, then retry the execution tool.';
  }
  if (state === 'failed') {
    return 'Workspace provisioning failed. Call forge_workspace_create again; this is not a repository permission problem.';
  }
  if (!isAgentForgeBranch(record.workspace.currentBranch)) {
    return branchPolicyFor(record.workspace.currentBranch).next_step;
  }
  return allowedNextActions[0]
    ? `Next safe tool: ${allowedNextActions[0]}`
    : 'Inspect forge_workspace_get for details.';
}

export class WorkspaceCoordinator extends DurableObject<Env> {
  private readonly app: ForgeApplicationService;
  private readonly metadata: D1MetadataStore;
  private mutationTail: Promise<void> = Promise.resolve();
  // The D1 row is a read-model for the capacity reaper and dashboard only. DO
  // storage is the source of truth, so D1 need not be rewritten on every
  // mutation — only when a field those readers use changes, or after a debounce
  // window so `updated_at` stays fresh within the minute-scale slot TTL.
  private lastD1: { signature: string; atMs: number } | null = null;
  private static readonly D1_DEBOUNCE_MS = 60_000;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.app = new ForgeApplicationService(new CloudflareSandboxProvider(env));
    this.metadata = new D1MetadataStore(env.METADATA);
  }

  private serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(action, action);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async getRecord(): Promise<WorkspaceRuntimeRecord> {
    const record = await this.ctx.storage.get<WorkspaceRuntimeRecord>(RECORD_KEY);
    if (!record) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_NOT_FOUND',
        message: 'Workspace was not found.',
        retryable: false
      });
    }
    return record;
  }

  /**
   * Load the workspace record and confirm the repository checkout still exists
   * before a repository-scoped operation runs. If the checkout has vanished the
   * workspace is marked failed and the degraded state is persisted so a later
   * forge_workspace_get reflects the loss instead of continuing to report ready.
   */
  private async repoRecord(): Promise<WorkspaceRuntimeRecord> {
    const record = await this.getRecord();
    // Skip the redundant pre-probe when a recent probe already confirmed the
    // checkout is healthy. A real missing checkout inside the TTL is still
    // caught by recoverCheckout when a downstream exec hits it.
    const checkout = record.workspace.checkout;
    if (
      checkout?.healthy &&
      Date.now() - Date.parse(checkout.checkedAt) < CHECKOUT_PROBE_TTL_MS
    ) {
      return record;
    }
    try {
      await this.app.assertCheckoutPresent(record);
    } catch (error) {
      // Self-heal an idle recycle by materializing the GitHub checkout again.
      try {
        await this.recoverCheckout(record);
        await this.save(record);
        return record;
      } catch {
        await this.save(record);
        throw error;
      }
    }
    return record;
  }

  // Re-materialize a missing checkout from GitHub.
  private async recoverCheckout(record: WorkspaceRuntimeRecord): Promise<void> {
    record.workspace.state = 'ready';
    const cloneSource = await repositoryCloneSource(this.env, record.workspace);
    await this.app.recoverCheckout(record, cloneSource);
  }

  private async save(record: WorkspaceRuntimeRecord): Promise<void> {
    const workspace = record.workspace;
    // Fields the reaper/dashboard actually read. A change to any of these — or a
    // stale debounce window — forces the D1 write; otherwise it is skipped.
    const signature = `${workspace.state}|${workspace.currentCommit ?? ''}|${workspace.currentBranch ?? ''}`;
    const now = Date.now();
    const writeD1 =
      this.lastD1 === null ||
      this.lastD1.signature !== signature ||
      now - this.lastD1.atMs >= WorkspaceCoordinator.D1_DEBOUNCE_MS;
    const writes: Array<Promise<unknown>> = [this.ctx.storage.put(RECORD_KEY, record)];
    if (writeD1) writes.push(this.metadata.putWorkspace(workspace));
    await Promise.all(writes);
    if (writeD1) this.lastD1 = { signature, atMs: now };
  }

  private async readWithRecovery<T>(action: (record: WorkspaceRuntimeRecord) => Promise<T>): Promise<T> {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      const revision = record.workspace.revision;
      const updatedAt = record.workspace.updatedAt;
      const divergenceAt = record.lastGitDivergence?.observedAt;
      try {
        return await action(record);
      } finally {
        if (
          record.workspace.revision !== revision ||
          record.workspace.updatedAt !== updatedAt ||
          record.lastGitDivergence?.observedAt !== divergenceAt
        ) await this.save(record);
      }
    });
  }

  private async readRepoWithRecovery<T>(action: (record: WorkspaceRuntimeRecord) => Promise<T>): Promise<T> {
    return this.serializeMutation(async () => {
      const record = await this.repoRecord();
      const revision = record.workspace.revision;
      const updatedAt = record.workspace.updatedAt;
      const divergenceAt = record.lastGitDivergence?.observedAt;
      try {
        return await action(record);
      } finally {
        if (
          record.workspace.revision !== revision ||
          record.workspace.updatedAt !== updatedAt ||
          record.lastGitDivergence?.observedAt !== divergenceAt
        ) await this.save(record);
      }
    });
  }


  async initialize(input: CreateWorkspaceInput): Promise<{
    workspaceId: string;
    state: string;
    operationId: string;
    revision: number;
    replay: boolean;
  }> {
    return this.serializeMutation(async () => {
      const existing = await this.ctx.storage.get<WorkspaceRuntimeRecord>(RECORD_KEY);
      if (existing) {
        const operation = existing.idempotency[input.idempotencyKey];
        if (!operation) {
          throw new ForgeError({
            code: 'FORGE_WORKSPACE_CONFLICT',
            message: 'The deterministic workspace ID is already in use.',
            retryable: false
          });
        }
        return {
          workspaceId: existing.workspace.id,
          state: existing.workspace.state,
          operationId: operation.operationId,
          revision: existing.workspace.revision,
          replay: true
        };
      }
      const record = this.app.initializeWorkspace(input);
      await this.save(record);
      const operation = record.idempotency[input.idempotencyKey];
      if (!operation) throw new Error('Workspace initialization lost its operation.');
      return {
        workspaceId: record.workspace.id,
        state: record.workspace.state,
        operationId: operation.operationId,
        revision: record.workspace.revision,
        replay: false
      };
    });
  }

  /**
   * Immutable authorization/address metadata only. This RPC must remain usable
   * when provisioning owns the mutation queue or the sandbox mount is absent.
   */
  async getAuthorizationBinding(): Promise<{
    tenantId: string;
    projectId: string;
    state: string;
    repository: WorkspaceRuntimeRecord['workspace']['repository'];
    requestedRef: string;
    currentBranch: string | null;
    revision: number;
    bootstrapRequested: boolean;
    executorSyncPending: boolean;
    githubEditInProgress: boolean;
    operationId?: OperationId;
  }> {
    const record = await this.ctx.storage.get<WorkspaceRuntimeRecord>(RECORD_KEY);
    if (!record) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_NOT_FOUND',
        message: 'Workspace metadata was not found. Check the workspace_id with forge_observer_workspaces before retrying.',
        retryable: false
      });
    }
    const operationId = Object.values(record.idempotency)[0]?.operationId;
    return {
      tenantId: record.workspace.tenantId,
      projectId: record.workspace.projectId,
      state: record.workspace.state,
      repository: record.workspace.repository,
      requestedRef: record.workspace.requestedRef,
      currentBranch: record.workspace.currentBranch ?? null,
      revision: record.workspace.revision,
      bootstrapRequested: record.bootstrapRequested ?? true,
      executorSyncPending: Boolean(record.pendingRemoteCommit),
      githubEditInProgress: Boolean(record.githubEditInProgress),
      ...(operationId ? { operationId } : {})
    };
  }

  async provisionInitialized(input: { bootstrap: boolean }): Promise<{
    ok: boolean;
    state: string;
    revision: number;
    retryable?: boolean;
    code?: string;
    message?: string;
  }> {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      if (record.workspace.state === 'ready') {
        return {
          ok: true,
          state: record.workspace.state,
          revision: record.workspace.revision
        };
      }
      try {
        const cloneSource = await repositoryCloneSource(this.env, record.workspace);
        await this.app.provisionWorkspace(
          record,
          input.bootstrap,
          (next) => this.save(next),
          cloneSource
        );
      } catch (error) {
        const forgeError = error instanceof ForgeError
          ? error
          : new ForgeError({
              code: 'FORGE_PROVIDER_UNAVAILABLE',
              message: error instanceof Error ? error.message : 'Workspace provisioning setup failed for an unknown reason. Retry the first execution tool; no command ran.',
              retryable: true,
              details: {
                stage: 'provision_setup',
                cause: error instanceof Error ? error.name : 'unknown'
              }
            });
        if (
          record.workspace.failure?.code !== forgeError.code ||
          record.workspace.failure.message !== forgeError.message
        ) {
          this.app.recordProvisioningFailure(record, forgeError);
        }
        await this.save(record);
        return {
          ok: false,
          state: record.workspace.state,
          revision: record.workspace.revision,
          retryable: forgeError.retryable,
          code: forgeError.code,
          message: forgeError.message
        };
      }
      return {
        ok: true,
        state: record.workspace.state,
        revision: record.workspace.revision
      };
    });
  }

  async provisionExhausted(): Promise<{ state: string; revision: number }> {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      const before = record.workspace.revision;
      this.app.markProvisioningExhausted(record);
      if (record.workspace.revision !== before) await this.save(record);
      return {
        state: record.workspace.state,
        revision: record.workspace.revision
      };
    });
  }

  /**
   * Return workspace state or null when no coordinator record exists, without
   * throwing across the RPC boundary. Used by forge_artifact_get to distinguish
   * a container-backed workspace from a URL-review workspace (which has no
   * coordinator) so its artifacts remain retrievable.
   */
  async tryGetState() {
    const record = await this.ctx.storage.get<WorkspaceRuntimeRecord>(RECORD_KEY);
    if (!record) return null;
    return this.getState();
  }

  async getState(options: { compact?: boolean } = {}) {
    return this.readWithRecovery(async (record) => {
      if (
        !record.pendingRemoteCommit &&
        ['ready', 'busy'].includes(record.workspace.state) &&
        await this.app.reconcileGitState(record)
      ) await this.save(record);
      // Build the gitIntegrity report. When there is a lastGitDivergence, the
      // state is 'diverged'. Otherwise, perform a lightweight probe to determine
      // the actual integrity state with reason and remediation.
      let gitIntegrity: {
        state: 'consistent' | 'unknown' | 'diverged' | 'corrupted';
        reason: string;
        blockingProcessId?: string;
        gitHeadReadable: boolean;
        gitIndexReadable: boolean;
        workingTreeReadable: boolean;
        recommendedAction: string;
        destructiveRecoveryRequired: boolean;
      };
      if (record.lastGitDivergence) {
        gitIntegrity = {
          state: 'diverged',
          reason: 'head_or_branch_mismatch',
          gitHeadReadable: true,
          gitIndexReadable: true,
          workingTreeReadable: true,
          recommendedAction: 'The recorded Git state differs from the executor filesystem. Destroy and recreate the workspace if a fresh GitHub checkout is required.',
          destructiveRecoveryRequired: false,
          ...record.lastGitDivergence
        };
      } else {
        gitIntegrity = {
          state: 'consistent',
          reason: 'all_checks_passed',
          gitHeadReadable: true,
          gitIndexReadable: true,
          workingTreeReadable: true,
          recommendedAction: 'Workspace is consistent. No action needed.',
          destructiveRecoveryRequired: false
        };
      }
      // Sync provider process status so completed background work no longer
      // appears as forever-running and blocking later tools.
      await this.app.syncProcessLifecycle(record).catch(() => ({ running: 0, completed: 0 }));
      const processes = Object.entries(record.processes).map(([id, value]) => ({
        id,
        ...value,
        status: managedProcessStatus(value)
      }));
      const activeProcessIds = processes.filter((process) => !process.completedAt).map((process) => process.id);
      const allowedNextActions = workspaceAllowedNextActions(record);
      const dependencyState = dependencyStateView(record.dependencyState);
      if (options.compact) {
        return {
          id: record.workspace.id,
          tenantId: record.workspace.tenantId,
          projectId: record.workspace.projectId,
          state: record.workspace.state,
          repository: record.workspace.repository,
          requestedRef: record.workspace.requestedRef,
          baseCommit: record.workspace.baseCommit,
          currentBranch: record.workspace.currentBranch,
          currentCommit: record.workspace.currentCommit,
          executorCommit: record.executorCommit ?? null,
          executorSyncPending: Boolean(record.pendingRemoteCommit),
          githubEditInProgress: Boolean(record.githubEditInProgress),
          revision: record.workspace.revision,
          persistenceMode: record.workspace.persistenceMode,
          runtimeProfile: record.workspace.runtimeProfile,
          createdAt: record.workspace.createdAt,
          updatedAt: record.workspace.updatedAt,
          dependencyState,
          gitIntegrity: {
            state: gitIntegrity.state,
            reason: gitIntegrity.reason,
            recommendedAction: gitIntegrity.recommendedAction,
            ...(gitIntegrity.blockingProcessId ? { blockingProcessId: gitIntegrity.blockingProcessId } : {})
          },
          activeProcessIds,
          processes: processes.map((process) => ({
            id: process.id,
            status: process.status,
            exitCode: process.exitCode,
            mutatesFilesystem: process.mutatesFilesystem,
            command: process.command.slice(0, 120)
          })),
          previewCount: Object.keys(record.previews).length,
          allowedNextActions,
          branch_policy: branchPolicyFor(record.workspace.currentBranch),
          next_step: nextStepForWorkspace(record, allowedNextActions)
        };
      }
      return {
        ...record.workspace,
        executorCommit: record.executorCommit ?? null,
        executorSyncPending: Boolean(record.pendingRemoteCommit),
        githubEditInProgress: Boolean(record.githubEditInProgress),
        branch_policy: branchPolicyFor(record.workspace.currentBranch),
        processes,
        previews: Object.fromEntries(
          Object.entries(record.previews).map(([id, value]) => [
            id,
            {
              port: value.port,
              processId: value.processId,
              access: value.access,
              expiresAt: value.expiresAt
            }
          ])
        ),
        gitIntegrity,
        dependencyState,
        activeProcessIds,
        allowedNextActions,
        next_step: nextStepForWorkspace(record, allowedNextActions),
      };
    });
  }

  async shellExec(input: {
    command: string;
    cwd: string;
    timeoutMs: number;
    environment: Record<string, string>;
    networkPolicy: NetworkPolicyMode;
    outputLimitBytes: number;
    expectedRevision?: number;
    idempotencyKey?: string;
    approved: boolean;
    mode?: 'read_only' | 'mutating';
  }) {
    const shellDecision = classifyCommand(input.command, input.networkPolicy);
    if (input.mode === 'read_only' && shellDecision.classification !== 'read_only') {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        // Say what to do, not just what was refused. The classifier is
        // conservative and flags shell constructs that only ever print, so an
        // agent meets this for a harmless command and has no way to know the
        // fix is simply to drop the parameter.
        message: 'This command was classified as possibly mutating, so mode:read_only was refused. Nothing ran. If it is safe to let it write, call forge_shell again without mode. Any files it changes will remain only in the ephemeral executor until you deliberately save them with forge_edit.',
        retryable: false,
        details: { classification: shellDecision.classification, allowedNextActions: ['forge_shell'] }
      });
    }
    const forcedReadOnly = input.mode === 'read_only' || shellDecision.classification === 'read_only';
    // Pure read-only probes skip the mutating-command path.
    if (forcedReadOnly) {
      return this.readWithRecovery(async (record) => {
        await this.prepareExecution(record);
        const normalizedCwd = input.cwd.replace(/\/+$/u, '') || '/';
        const value = await this.app.exec(record, {
          command: input.command,
          cwd: normalizedCwd,
          timeoutMs: input.timeoutMs,
          environment: nonInteractiveShellEnv(input.environment),
          networkPolicy: input.networkPolicy,
          outputLimitBytes: input.outputLimitBytes,
          approved: input.approved
        });
        return {
          ...value,
          mode: 'read_only' as const,
          allowedNextActions: workspaceAllowedNextActions(record)
        };
      });
    }
    // Mutating commands serialize: a repo probe may recover a sleeping
    // checkout, and that state transition must not overwrite a newer mutation.
    return this.serializeMutation(async () => {
      const normalizedCwd = input.cwd.replace(/\/+$/u, '') || '/';
      const touchesRepo = normalizedCwd === '/workspace/repo' || normalizedCwd.startsWith('/workspace/repo/');
      const record = touchesRepo ? await this.repoRecord() : await this.getRecord();
      await this.prepareExecution(record);
      const before = record.workspace.revision;
      const updatedAt = record.workspace.updatedAt;
      const divergenceAt = record.lastGitDivergence?.observedAt;
      const managedProcessResult = (
        started: {
          value: { id: string; status?: string };
          operationId: unknown;
          replay?: boolean;
        },
        decision: { classification: string },
        stderr: string,
        durationMs: number
      ) => {
        const processId = started.value.id;
        const entry = record.processes[processId];
        const startedAt = entry?.startedAt ?? new Date().toISOString();
        const status = entry?.completedAt
          ? entry.exitCode === 0
            ? 'exited'
            : entry.exitCode === 124
              ? 'cancelled'
              : 'failed'
          : (started.value.status ?? 'running');
        return {
          // Omit numeric exitCode until the process is terminal so agents do not
          // treat "started" as success (`!exitCode` / null-as-zero).
          status: entry?.completedAt ? 'completed' : 'started',
          ...(entry?.completedAt ? { exitCode: entry.exitCode ?? 1 } : {}),
          stdout: '',
          stderr,
          truncated: false,
          durationMs,
          artifactRefs: [] as string[],
          ...(started.replay ? { replay: true } : {}),
          workspaceId: record.workspace.id,
          branch: record.workspace.currentBranch,
          head: entry?.executorCommit ?? record.executorCommit ?? record.workspace.currentCommit,
          baseCommit: record.workspace.baseCommit,
          classification: decision.classification,
          operationId: started.operationId,
          workspaceRevision: record.workspace.revision,
          managedProcess: {
            processId,
            status,
            startedAt,
            command: input.command,
            workspaceRevision: record.workspace.revision,
            ...(entry?.completedAt ? { completedAt: entry.completedAt, exitCode: entry.exitCode } : {})
          },
          next_step: entry?.completedAt
            ? `Managed process ${processId} already finished with exit ${entry.exitCode ?? 1}.`
            : `Call forge_process_wait with process_id ${processId} (use a timeout_ms of at least 600000 for large installs), then continue with shell commands.`,
          allowedNextActions: entry?.completedAt
            ? ['forge_process_list', 'forge_shell', 'forge_workspace_get']
            : ['forge_process_wait', 'forge_process_logs', 'forge_process_list']
        };
      };
      try {
        const environment = nonInteractiveShellEnv(input.environment);
        // Dependency installs always start as managed processes once approved.
        // Sync exec + timeout conversion restarted the install after the transport
        // deadline and left later shells unable to see node_modules.
        if (
          shellDecision.classification === 'dependency_install' &&
          input.approved &&
          input.idempotencyKey &&
          touchesRepo
        ) {
          const started = await this.app.startProcess(record, {
            command: input.command,
            cwd: normalizedCwd,
            environment,
            networkPolicy: input.networkPolicy as Exclude<NetworkPolicyMode, 'unrestricted_with_approval'>,
            expectedRevision: input.expectedRevision,
            idempotencyKey: input.idempotencyKey,
            approved: true
          });
          return managedProcessResult(
            {
              value: started.value,
              operationId: started.operationId,
              replay: 'replay' in started && started.replay === true
            },
            shellDecision,
            'replay' in started && started.replay
              ? 'Replayed dependency install managed process.'
              : 'Dependency install started as a managed background process so it can outlive the transport deadline without being restarted.',
            0
          );
        }
        const value = await this.app.exec(record, {
          command: input.command,
          cwd: normalizedCwd,
          timeoutMs: input.timeoutMs,
          environment,
          networkPolicy: input.networkPolicy,
          outputLimitBytes: input.outputLimitBytes,
          expectedRevision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          approved: input.approved
        });
        return { ...value, mode: 'mutating' as const };
      } catch (error) {
        // If the command was a mutating command with an idempotency key and it
        // timed out (FORGE_COMMAND_TIMEOUT), convert it to a managed background
        // process so it continues under Forge supervision. The caller can then
        // use forge_process_wait / forge_process_list / forge_process_stop.
        // Skip dependency_install: those are started as managed processes above,
        // and restarting them here would race two package managers on one tree.
        if (
          error instanceof ForgeError &&
          error.code === 'FORGE_COMMAND_TIMEOUT' &&
          input.idempotencyKey &&
          touchesRepo
        ) {
          if (shellDecision.classification === 'dependency_install') throw error;
          const started = await this.app.startProcess(record, {
            command: input.command,
            cwd: normalizedCwd,
            environment: nonInteractiveShellEnv(input.environment),
            networkPolicy: input.networkPolicy as Exclude<NetworkPolicyMode, 'unrestricted_with_approval'>,
            expectedRevision: input.expectedRevision,
            idempotencyKey: `${input.idempotencyKey}:bg`,
            approved: input.approved
          });
          // Link the original key to the managed process so a ChatGPT retry with
          // the same idempotency_key does not fake exitCode 0.
          if (record.idempotency[input.idempotencyKey]) {
            record.idempotency[input.idempotencyKey] = {
              ...record.idempotency[input.idempotencyKey]!,
              processId: started.value.id
            };
          }
          return managedProcessResult(
            {
              value: started.value,
              operationId: started.operationId,
              replay: 'replay' in started && started.replay === true
            },
            shellDecision,
            'replay' in started && started.replay
              ? 'Replayed managed background process for a timed-out command.'
              : 'Command timed out and was converted to a managed background process.',
            input.timeoutMs
          );
        }
        throw error;
      } finally {
        if (
          record.workspace.revision !== before ||
          record.workspace.updatedAt !== updatedAt ||
          record.lastGitDivergence?.observedAt !== divergenceAt
        ) await this.save(record);
      }
    });
  }

  async processStart(input: {
    command: string;
    cwd: string;
    environment: Record<string, string>;
    networkPolicy: Exclude<NetworkPolicyMode, 'unrestricted_with_approval'>;
    expectedRevision?: number;
    idempotencyKey: string;
    approved?: boolean;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        await this.prepareExecution(record);
        return await this.app.startProcess(record, input);
      } finally {
        await this.save(record);
      }
    });
  }

  async processLogs(input: { processId: ProcessId; cursor?: string }) {
    return this.readWithRecovery((record) => this.app.processLogs(record, input.processId, input.cursor));
  }

  async processGet(input: { processId: ProcessId }) {
    return this.readWithRecovery((record) => this.app.processGet(record, input.processId));
  }

  async processStop(input: { processId: ProcessId; expectedRevision?: number; idempotencyKey: string }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        return await this.app.stopProcess(record, input.processId, input.expectedRevision, input.idempotencyKey);
      } finally {
        await this.save(record);
      }
    });
  }

  async processWait(input: { processId: ProcessId; timeoutMs?: number }) {
    // Poll in short DO-lock slices so workspace_get / process_list / shell probes
    // can still run while ChatGPT waits on a long install. Holding the mutation
    // lock for the full timeout made recovery tools appear dead and caused
    // retry storms.
    const timeoutMs = Math.max(250, Math.min(input.timeoutMs ?? 30_000, 30_000));
    const sliceMs = 2_500;
    const deadline = Date.now() + timeoutMs;
    let lastTimedOut: Awaited<ReturnType<ForgeApplicationService['processWait']>> | null = null;
    while (Date.now() < deadline) {
      const waitSlice = Math.max(250, Math.min(sliceMs, deadline - Date.now()));
      const result = await this.readWithRecovery((record) =>
        this.app.processWait(record, input.processId, waitSlice)
      );
      if (!result.timedOut) return result;
      lastTimedOut = result;
    }
    if (lastTimedOut) {
      return {
        ...lastTimedOut,
        suggestedTimeoutMs: 30_000,
        next_step: `Process ${input.processId} is still running after this bounded observation. Call forge_process_wait again with the same process_id; each call observes for at most 30000ms and never restarts or kills the process.`
      };
    }
    return this.readWithRecovery((record) => this.app.processWait(record, input.processId, 250));
  }

  async processCancel(input: { processId: ProcessId; expectedRevision?: number; idempotencyKey: string }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        return await this.app.processCancel(record, input.processId, input.expectedRevision, input.idempotencyKey);
      } finally {
        await this.save(record);
      }
    });
  }

  async processList() {
    return this.readWithRecovery((record) => this.app.processList(record));
  }

  private static readonly LIVE_ACTIVITY_KEY = 'forge_live_activity_v1';
  private static readonly LIVE_ACTIVITY_MAX = 80;

  async appendLiveActivity(input: {
    tool: string;
    status: 'success' | 'error';
    durationMs: number;
    errorCode?: string;
    at?: string;
  }): Promise<void> {
    const list = (await this.ctx.storage.get<Array<{
      at: string;
      tool: string;
      status: 'success' | 'error';
      durationMs: number;
      errorCode?: string;
    }>>(WorkspaceCoordinator.LIVE_ACTIVITY_KEY)) ?? [];
    list.push({
      at: input.at ?? new Date().toISOString(),
      tool: input.tool,
      status: input.status,
      durationMs: input.durationMs,
      errorCode: input.errorCode
    });
    while (list.length > WorkspaceCoordinator.LIVE_ACTIVITY_MAX) list.shift();
    await this.ctx.storage.put(WorkspaceCoordinator.LIVE_ACTIVITY_KEY, list);
  }

  /**
   * Read-only bundle for the portal live view: workspace metadata, recent MCP
   * tools (recorded asynchronously), processes, and a log tail. Does not run
   * full doctor reconcile or Git repair.
   */
  async getObserverSnapshot(): Promise<{
    workspace: {
      state: string;
      branch: string | null | undefined;
      head: string | null | undefined;
      requestedRef: string;
      revision: number;
      updatedAt: string;
    };
    processes: Array<{
      id: string;
      command: string;
      status: string;
      startedAt?: string;
      completedAt?: string;
      exitCode?: number;
    }>;
    activity: Array<{
      at: string;
      tool: string;
      status: 'success' | 'error';
      durationMs: number;
      errorCode?: string;
    }>;
    logTail: { processId: string; command: string; data: string; truncated: boolean } | null;
  } | null> {
    const stored = await this.ctx.storage.get<WorkspaceRuntimeRecord>(RECORD_KEY);
    if (!stored) return null;
    const activity = (await this.ctx.storage.get<Array<{
      at: string;
      tool: string;
      status: 'success' | 'error';
      durationMs: number;
      errorCode?: string;
    }>>(WorkspaceCoordinator.LIVE_ACTIVITY_KEY)) ?? [];
    return this.readWithRecovery(async (record) => {
      await this.app.syncProcessLifecycle(record).catch(() => ({ running: 0, completed: 0 }));
      const processes = Object.entries(record.processes).map(([id, value]) => ({
        id,
        command: value.command,
        status: managedProcessStatus(value),
        startedAt: value.startedAt,
        completedAt: value.completedAt,
        exitCode: value.exitCode
      }));
      const focus = processes.find((process) => !process.completedAt) ?? processes[processes.length - 1];
      let logTail: { processId: string; command: string; data: string; truncated: boolean } | null = null;
      if (focus) {
        const logs = await this.app.processLogs(record, focus.id as ProcessId).catch(() => null);
        if (logs?.data) {
          const truncated = logs.truncated || logs.data.length > 12_000;
          const data = logs.data.length > 12_000 ? logs.data.slice(-12_000) : logs.data;
          logTail = { processId: focus.id, command: focus.command, data, truncated };
        }
      }
      return {
        workspace: {
          state: record.workspace.state,
          branch: record.workspace.currentBranch,
          head: record.workspace.currentCommit,
          requestedRef: record.workspace.requestedRef,
          revision: record.workspace.revision,
          updatedAt: record.workspace.updatedAt
        },
        processes,
        activity,
        logTail
      };
    });
  }

  async operationGet(input: { operationId: OperationId }) {
    return this.readWithRecovery((record) => this.app.operationGet(record, input.operationId));
  }

  async dependenciesInstall(input: {
    frozenLockfile?: boolean;
    allowLockfileUpdate?: boolean;
    networkPolicy: NetworkPolicyMode;
    timeoutMs?: number;
    expectedRevision?: number;
    idempotencyKey: string;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.repoRecord();
      try {
        await this.prepareExecution(record);
        const result = await this.app.dependenciesInstall(record, input);
        return result;
      } finally {
        await this.save(record);
      }
    });
  }

  /**
   * Remember the content an agent was actually shown, so a later whole-file
   * write can be checked against it.
   *
   * This lives in Durable Object storage rather than the MCP session because
   * the session object does not survive between tool calls. Held there, the
   * record was empty by the time the next call arrived, so "have you read
   * this file" was permanently false and no existing file could ever be
   * edited — a guard that deadlocked instead of protecting.
   */
  async rememberReads(input: { entries: Array<{ path: string; sha: string }> }): Promise<void> {
    if (!input.entries.length) return;
    await this.ctx.storage.put(
      Object.fromEntries(input.entries.map((entry) => [`seen:${entry.path}`, entry.sha]))
    );
  }

  async seenBlobs(input: { paths: string[] }): Promise<Record<string, string>> {
    if (!input.paths.length) return {};
    const stored = await this.ctx.storage.get<string>(input.paths.map((path) => `seen:${path}`));
    const seen: Record<string, string> = {};
    for (const [key, value] of stored) {
      if (typeof value === 'string') seen[key.slice('seen:'.length)] = value;
    }
    return seen;
  }

  async forgetReads(input: { paths: string[] }): Promise<void> {
    if (!input.paths.length) return;
    await this.ctx.storage.delete(input.paths.map((path) => `seen:${path}`));
  }

  private activeMutatingProcessIds(record: WorkspaceRuntimeRecord): string[] {
    return Object.entries(record.processes)
      .filter(([, process]) => process.mutatesFilesystem && !process.completedAt)
      .map(([id]) => id);
  }

  private async prepareExecution(record: WorkspaceRuntimeRecord): Promise<void> {
    if (record.githubEditInProgress) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_CONFLICT',
        message: 'A forge_edit GitHub mutation is still being finalized, so Forge will not run an executor command against an uncertain checkout. Retry forge_edit with the same input. If its coordinator handoff could not be confirmed, call forge_workspace_destroy, then forge_workspace_create before executing.',
        retryable: true,
        details: {
          branch: record.githubEditInProgress.branch,
          startedAt: record.githubEditInProgress.startedAt,
          next_step: 'Retry forge_edit with the same files/idempotency key, or destroy and recreate the workspace.'
        }
      });
    }
    if (!record.pendingRemoteCommit) return;
    const synced = await this.syncPendingRemoteCommit(record);
    if (synced) return;
    const activeProcessIds = this.activeMutatingProcessIds(record);
    throw new ForgeError({
      code: 'FORGE_WORKSPACE_CONFLICT',
      message: 'GitHub has a newer durable commit, but the loaded executor still has an active mutating process. Call forge_process_wait or forge_process_stop for that process; execution remains blocked until the executor is synchronized.',
      retryable: true,
      details: { activeProcessIds, commit: record.pendingRemoteCommit.commit }
    });
  }

  private async syncPendingRemoteCommit(record: WorkspaceRuntimeRecord): Promise<boolean> {
    const pending = record.pendingRemoteCommit;
    if (!pending) return true;
    await this.app.syncProcessLifecycle(record).catch(() => undefined);
    if (this.activeMutatingProcessIds(record).length > 0) return false;
    const cloneSource = await repositoryCloneSource(this.env, record.workspace);
    await this.app.syncRemoteCommit(
      record,
      pending.commit,
      pending.branch,
      pending.invalidateDependencies,
      cloneSource
    );
    record.pendingRemoteCommit = undefined;
    return true;
  }

  /**
   * Record a commit created through the GitHub CRUD plane and propagate it into
   * an already-loaded executor without turning executor files into GitHub edits.
   */
  async beginGitHubEdit(input: { branch: string; intentHash: string }): Promise<{ token: string; revision: number; replayed: boolean }> {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      record.executorCommit ??= record.workspace.currentCommit;
      const active = record.githubEditInProgress;
      if (active) {
        if (active.branch === input.branch && active.intentHash === input.intentHash) {
          return { token: active.token, revision: record.workspace.revision, replayed: true };
        }
        throw new ForgeError({
          code: 'FORGE_WORKSPACE_CONFLICT',
          message: 'Another forge_edit is still finalizing its GitHub mutation. Retry forge_edit with the same input, or call forge_workspace_destroy then forge_workspace_create if its handoff could not be confirmed.',
          retryable: true,
          details: { branch: active.branch, startedAt: active.startedAt }
        });
      }
      const token = `edit_${crypto.randomUUID().replaceAll('-', '')}`;
      record.githubEditInProgress = {
        token,
        branch: input.branch,
        intentHash: input.intentHash,
        startedAt: new Date().toISOString()
      };
      await this.save(record);
      return { token, revision: record.workspace.revision, replayed: false };
    });
  }

  async cancelGitHubEdit(input: { token: string }): Promise<{ cancelled: boolean }> {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      if (!record.githubEditInProgress) {
        return { cancelled: false };
      }
      if (record.githubEditInProgress.token !== input.token) {
        throw new ForgeError({
          code: 'FORGE_WORKSPACE_CONFLICT',
          message: 'The forge_edit cancellation token does not own the active edit.',
          retryable: false
        });
      }
      record.githubEditInProgress = undefined;
      await this.save(record);
      return { cancelled: true };
    });
  }

  async recordGitHubCommit(input: { token: string; commit: string; branch: string; invalidateDependencies?: boolean }): Promise<{ executorSynced: boolean; revision: number; replayed: boolean }> {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      const previous = record.lastRecordedGitHubEdit;
      if (previous?.token === input.token) {
        if (previous.commit !== input.commit || previous.branch !== input.branch) {
          throw new ForgeError({
            code: 'FORGE_WORKSPACE_CONFLICT',
            message: 'This forge_edit token was already recorded for a different GitHub commit.',
            retryable: false
          });
        }
        const executorSynced = record.executorCommit === input.commit && !record.pendingRemoteCommit;
        if (!executorSynced && record.pendingRemoteCommit) {
          try {
            const synced = await this.syncPendingRemoteCommit(record);
            await this.save(record);
            return { executorSynced: synced, revision: record.workspace.revision, replayed: true };
          } catch (error) {
            await this.save(record);
            throw error;
          }
        }
        return { executorSynced, revision: record.workspace.revision, replayed: true };
      }
      if (record.githubEditInProgress?.token !== input.token) {
        throw new ForgeError({
          code: 'FORGE_WORKSPACE_CONFLICT',
          message: 'Forge cannot attach this GitHub commit to the workspace because its edit token is absent or stale. Call forge_workspace_destroy, then forge_workspace_create before running commands.',
          retryable: false,
          details: { branch: input.branch, commit: input.commit }
        });
      }
      if (record.githubEditInProgress.branch !== input.branch) {
        throw new ForgeError({
          code: 'FORGE_WORKSPACE_CONFLICT',
          message: 'The completed GitHub commit belongs to a different branch than the active forge_edit token.',
          retryable: false
        });
      }
      record.workspace.currentCommit = input.commit;
      record.workspace.currentBranch = input.branch;
      record.workspace.revision = nextRevision(record.workspace.revision);
      record.workspace.updatedAt = new Date().toISOString();
      record.lastRecordedGitHubEdit = { token: input.token, commit: input.commit, branch: input.branch };
      record.githubEditInProgress = undefined;

      // A requested workspace has no executor to update; first materialization
      // clones the current GitHub branch directly.
      if (!['ready', 'busy'].includes(record.workspace.state)) {
        record.pendingRemoteCommit = undefined;
        await this.save(record);
        return { executorSynced: true, revision: record.workspace.revision, replayed: false };
      }

      if (record.executorCommit === input.commit) {
        record.pendingRemoteCommit = undefined;
        await this.save(record);
        return { executorSynced: true, revision: record.workspace.revision, replayed: false };
      }

      record.pendingRemoteCommit = {
        commit: input.commit,
        branch: input.branch,
        recordedAt: new Date().toISOString(),
        invalidateDependencies: input.invalidateDependencies === true
      };
      record.workspace.checkout = {
        healthy: false,
        checkedAt: new Date().toISOString(),
        detail: 'The loaded executor is waiting to advance to the latest GitHub commit.'
      };
      let executorSynced = false;
      try {
        executorSynced = await this.syncPendingRemoteCommit(record);
      } finally {
        await this.save(record);
      }
      return { executorSynced, revision: record.workspace.revision, replayed: false };
    });
  }

  /** Retry a deferred GitHub-to-executor sync before an execution tool runs. */
  async ensureGitHubCheckout(): Promise<{ synced: true; revision: number }> {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        if (!record.pendingRemoteCommit && !record.githubEditInProgress) {
          return { synced: true, revision: record.workspace.revision };
        }
        await this.prepareExecution(record);
        return { synced: true, revision: record.workspace.revision };
      } finally {
        await this.save(record);
      }
    });
  }

  /**
   * Replay cache for remote mutations whose side effect happens outside the
   * coordinator. The intent hash prevents one key from silently authorising a
   * different edit after a client retry or context loss.
   */
  async remoteMutationReplay(input: { kind: 'edit'; idempotencyKey: string; intentHash: string }) {
    const key = `remote-mutation:${input.kind}:${encodeURIComponent(input.idempotencyKey)}`;
    const stored = await this.ctx.storage.get<{ intentHash: string; receipt: Record<string, unknown> }>(key);
    if (!stored) return null;
    if (stored.intentHash !== input.intentHash) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_CONFLICT',
        message: 'This idempotency key already belongs to a different forge_edit intent. Reuse the original files and message, or call forge_edit with a fresh key for the new change.',
        retryable: false,
        details: { kind: input.kind }
      });
    }
    return stored.receipt;
  }

  async recordRemoteMutation(input: {
    kind: 'edit';
    idempotencyKey: string;
    intentHash: string;
    receipt: Record<string, unknown>;
  }): Promise<void> {
    const key = `remote-mutation:${input.kind}:${encodeURIComponent(input.idempotencyKey)}`;
    await this.ctx.storage.put(key, { intentHash: input.intentHash, receipt: input.receipt });
  }

  async gitStatus() {
    return this.readRepoWithRecovery(async (record) => {
      await this.app.reconcileGitState(record);
      return this.app.gitStatus(record);
    });
  }

  /**
   * Used by the review preview on the approval page: a reviewer clicking "launch
   * preview" has no agent to drive the usual detect → process_start →
   * preview_expose sequence for them, and the detection result lives on the DO
   * record rather than in the exposed workspace state. Doing all three steps here
   * keeps that record private and makes the operation idempotent — a second click
   * while the first preview is still live returns the same preview instead of
   * starting a second dev server on the same port.
   */
  async startReviewPreview(input: { hostname: string; ttlSeconds: number }): Promise<
    { ready: true; previewId: string; port: number; expiresAt: string } | { ready: false; reason: string }
  > {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        await this.prepareExecution(record);
        if (record.workspace.state !== 'ready') {
          return { ready: false as const, reason: `workspace is ${record.workspace.state}` };
        }
        const devCommand = record.detection?.devCommand;
        if (!devCommand) {
          return { ready: false as const, reason: 'no dev server command was detected for this project' };
        }
        const port = record.detection?.expectedPorts?.[0] ?? 3000;

        const live = Object.entries(record.previews).find(
          ([, preview]) => preview.port === port && Date.parse(preview.expiresAt) > Date.now()
        );
        if (live) {
          return { ready: true as const, previewId: live[0], port, expiresAt: live[1].expiresAt };
        }

        const existingProcess = Object.entries(record.processes).find(
          ([, value]) => value.command === devCommand && !value.completedAt
        );
        let processId = existingProcess?.[0];
        if (!processId) {
          const started = await this.app.startProcess(record, {
            command: devCommand,
            cwd: '/workspace/repo',
            environment: {},
            networkPolicy: 'development',
            idempotencyKey: `review-preview-process-${record.workspace.id}`
          });
          processId = started.value.id;
        }
        if (!processId) return { ready: false as const, reason: 'the dev server did not start' };

        const exposed = await this.app.exposePreview(record, {
          processId: processId as ProcessId,
          port,
          hostname: input.hostname,
          access: 'private',
          ttlSeconds: input.ttlSeconds,
          idempotencyKey: `review-preview-expose-${record.workspace.id}-${port}`
        });
        if ('replay' in exposed && exposed.replay) {
          const found = Object.entries(record.previews).find(([, preview]) => preview.port === port);
          return found
            ? { ready: true as const, previewId: found[0], port, expiresAt: found[1].expiresAt }
            : { ready: false as const, reason: 'preview is still starting' };
        }
        return exposed.previewId && exposed.expiresAt
          ? { ready: true as const, previewId: exposed.previewId, port, expiresAt: exposed.expiresAt }
          : { ready: false as const, reason: 'preview is still starting' };
      } finally {
        await this.save(record);
      }
    });
  }

  async previewExpose(input: {
    processId: ProcessId;
    port: number;
    hostname: string;
    access: 'private' | 'tenant' | 'share-link' | 'public';
    ttlSeconds: number;
    expectedRevision?: number;
    idempotencyKey: string;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        await this.prepareExecution(record);
        return await this.app.exposePreview(record, input);
      } finally {
        await this.save(record);
      }
    });
  }

  async getPreviewInternal(previewId: string) {
    const record = await this.getRecord();
    const preview = record.previews[previewId];
    if (!preview) {
      throw new ForgeError({
        code: 'FORGE_PREVIEW_UNAVAILABLE',
        message: 'Preview was not found.',
        retryable: false
      });
    }
    return { workspace: record.workspace, preview, providerId: record.providerId };
  }

  async requestDestroy(input: {
    expectedRevision?: number;
    idempotencyKey: string;
    force?: boolean;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        return this.app.requestDestroy(
          record,
          input.expectedRevision,
          input.idempotencyKey
        );
      } finally {
        await this.save(record);
      }
    });
  }

  async completeDestroy(input: { force?: boolean } = {}) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        const value = await this.app.completeDestroy(record);
        await this.ctx.storage.delete(LEASE_KEY);
        return value;
      } finally {
        await this.save(record);
      }
    });
  }
}
