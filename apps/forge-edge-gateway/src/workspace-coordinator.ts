import { DurableObject } from 'cloudflare:workers';
import {
  ForgeApplicationService,
  type CreateWorkspaceInput,
  type WorkspaceRuntimeRecord
} from '@forge/application';
import { ForgeError, type ProcessId } from '@forge/core';
import { D1MetadataStore } from '@forge/metadata-d1';
import { CloudflareSandboxProvider } from '@forge/sandbox-cloudflare';
import type { NetworkPolicyMode } from '@forge/sandbox-core';
import type { Env } from './env';
import { repositoryCloneSource, repositoryPushSource } from './github';

const RECORD_KEY = 'workspace-runtime';
const LEASE_KEY = 'mutation-lease';

interface MutationLease {
  holder: string;
  token: string;
  expiresAt: string;
}

export class WorkspaceCoordinator extends DurableObject<Env> {
  private readonly app: ForgeApplicationService;
  private readonly metadata: D1MetadataStore;
  private mutationTail: Promise<void> = Promise.resolve();

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
    return { ...record, snapshots: record.snapshots ?? {}, checks: record.checks ?? {} };
  }

  private async save(record: WorkspaceRuntimeRecord): Promise<void> {
    const writes: Array<Promise<unknown>> = [
      this.ctx.storage.put(RECORD_KEY, record),
      this.metadata.putWorkspace(record.workspace)
    ];
    if (record.lastRecoveryVerifiedAt) {
      writes.push(
        this.env.METADATA.prepare(
          `INSERT INTO service_verifications (name, verified_at, evidence)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(name) DO UPDATE SET verified_at=excluded.verified_at, evidence=excluded.evidence
           WHERE excluded.verified_at >= service_verifications.verified_at`
        ).bind(
          'workspace_recovery',
          record.lastRecoveryVerifiedAt,
          JSON.stringify({
            workspaceId: record.workspace.id,
            snapshotId: record.workspace.activeSnapshotId ?? null,
            commit: record.workspace.currentCommit ?? null,
            branch: record.workspace.currentBranch ?? null,
            recoveryVersion: this.env.CF_VERSION_METADATA.id
          })
        ).run()
      );
    }
    await Promise.all(writes);
  }

  private assertCheckpointQuiescent(record: WorkspaceRuntimeRecord): void {
    const processIds = Object.keys(record.processes);
    if (processIds.length > 0) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_CONFLICT',
        message: 'Stop workspace-owned processes before a filesystem mutation or checkpoint so Forge can capture an immutable recovery snapshot.',
        retryable: true,
        details: { processIds }
      });
    }
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

  async acquireLease(input: {
    holder: string;
    ttlSeconds: number;
  }): Promise<MutationLease> {
    return this.serializeMutation(async () => {
      const current = await this.ctx.storage.get<MutationLease>(LEASE_KEY);
      if (
        current &&
        Date.parse(current.expiresAt) > Date.now() &&
        current.holder !== input.holder
      ) {
        throw new ForgeError({
          code: 'FORGE_WORKSPACE_CONFLICT',
          message: 'Another actor currently holds the workspace mutation lease.',
          retryable: true,
          details: { holder: current.holder, expiresAt: current.expiresAt }
        });
      }
      const lease = {
        holder: input.holder,
        token: crypto.randomUUID(),
        expiresAt: new Date(
          Date.now() + Math.min(input.ttlSeconds, 300) * 1000
        ).toISOString()
      };
      await this.ctx.storage.put(LEASE_KEY, lease);
      return lease;
    });
  }

  async renewLease(input: {
    holder: string;
    token: string;
    ttlSeconds: number;
  }): Promise<MutationLease> {
    return this.serializeMutation(async () => {
      const current = await this.ctx.storage.get<MutationLease>(LEASE_KEY);
      if (
        !current ||
        current.holder !== input.holder ||
        current.token !== input.token
      ) {
        throw new ForgeError({
          code: 'FORGE_LEASE_REQUIRED',
          message: 'A valid workspace mutation lease is required.',
          retryable: false
        });
      }
      const lease = {
        ...current,
        expiresAt: new Date(
          Date.now() + Math.min(input.ttlSeconds, 300) * 1000
        ).toISOString()
      };
      await this.ctx.storage.put(LEASE_KEY, lease);
      return lease;
    });
  }

  async releaseLease(input: { holder: string; token: string }): Promise<void> {
    return this.serializeMutation(async () => {
      const current = await this.ctx.storage.get<MutationLease>(LEASE_KEY);
      if (current?.holder === input.holder && current.token === input.token) {
        await this.ctx.storage.delete(LEASE_KEY);
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
        await this.save(record);
        const forgeError = error instanceof ForgeError
          ? error
          : new ForgeError({
              code: 'FORGE_PROVIDER_UNAVAILABLE',
              message: 'Workspace provisioning failed.',
              retryable: true
            });
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

  async getState() {
    return this.readWithRecovery(async (record) => {
      if (['ready', 'busy'].includes(record.workspace.state) && await this.app.reconcileGitState(record)) await this.save(record);
      const lease = await this.ctx.storage.get<MutationLease>(LEASE_KEY);
      return {
        ...record.workspace,
        processes: record.processes,
        checks: record.checks,
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
        checkpoints: Object.values(record.snapshots).map((snapshot) => ({
          snapshotId: snapshot.id,
          createdAt: snapshot.createdAt,
          providerVersion: snapshot.providerVersion
        })),
        gitIntegrity: record.lastGitDivergence
          ? { state: 'diverged', ...record.lastGitDivergence }
          : { state: 'consistent' },
        recovery: record.lastRecoveryVerifiedAt
          ? { verifiedAt: record.lastRecoveryVerifiedAt, snapshotId: record.workspace.activeSnapshotId ?? null }
          : { verifiedAt: null },
        lease:
          lease && Date.parse(lease.expiresAt) > Date.now()
            ? { holder: lease.holder, expiresAt: lease.expiresAt }
            : null
      };
    });
  }

  async filesTree(input: { path: string; depth: number; limit: number }) {
    return this.readWithRecovery((record) => this.app.tree(record, input));
  }

  async filesRead(input: {
    path: string;
    startLine?: number;
    endLine?: number;
    maxBytes: number;
  }) {
    return this.readWithRecovery((record) => this.app.read(record, input));
  }

  async filesWrite(input: {
    path: string;
    content: string;
    expectedSha256?: string;
    expectedRevision?: number;
    idempotencyKey: string;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        this.assertCheckpointQuiescent(record);
        const value = await this.app.write(record, input, input.expectedRevision, input.idempotencyKey);
        const checkpoint = await this.app.checkpoint(record, `write-${record.workspace.revision}`);
        return { ...value, checkpoint };
      } finally {
        await this.save(record);
      }
    });
  }

  async filesPatch(input: {
    patch: string;
    expectedRevision?: number;
    idempotencyKey: string;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        this.assertCheckpointQuiescent(record);
        const value = await this.app.patch(
          record,
          { patch: input.patch, cwd: '/workspace/repo' },
          input.expectedRevision,
          input.idempotencyKey
        );
        const checkpoint = await this.app.checkpoint(record, `patch-${record.workspace.revision}`);
        return { ...value, checkpoint };
      } finally {
        await this.save(record);
      }
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
  }) {
    const action = async () => {
      const record = await this.getRecord();
      const before = record.workspace.revision;
      const updatedAt = record.workspace.updatedAt;
      const divergenceAt = record.lastGitDivergence?.observedAt;
      try {
        if (input.idempotencyKey) this.assertCheckpointQuiescent(record);
        const value = await this.app.exec(record, {
          command: input.command,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          environment: input.environment,
          networkPolicy: input.networkPolicy,
          outputLimitBytes: input.outputLimitBytes,
          expectedRevision: input.expectedRevision,
          idempotencyKey: input.idempotencyKey,
          approved: input.approved
        });
        const checkpoint = value.classification === 'read_only' ? undefined : await this.app.checkpoint(record, `shell-${record.workspace.revision}`);
        return checkpoint ? { ...value, checkpoint } : value;
      } finally {
        if (
          record.workspace.revision !== before ||
          record.workspace.updatedAt !== updatedAt ||
          record.lastGitDivergence?.observedAt !== divergenceAt
        ) await this.save(record);
      }
    };
    // Even a read-only command can discover a sleeping mount and trigger a
    // recovery. Keep that state transition in the same durable ordering as
    // writes so a stale read record can never overwrite a newer mutation.
    return this.serializeMutation(action);
  }

  async processStart(input: {
    command: string;
    cwd: string;
    environment: Record<string, string>;
    networkPolicy: Exclude<NetworkPolicyMode, 'unrestricted_with_approval'>;
    expectedRevision?: number;
    idempotencyKey: string;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
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

  async checkStart(input: {
    name: string;
    command: string;
    cwd: string;
    environment: Record<string, string>;
    networkPolicy: Exclude<NetworkPolicyMode, 'unrestricted_with_approval'>;
    expectedRevision?: number;
    idempotencyKey: string;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        return await this.app.startCheck(record, input);
      } finally {
        await this.save(record);
      }
    });
  }

  async checkGet(input: { processId: ProcessId }) {
    return this.readWithRecovery((record) => this.app.checkGet(record, input.processId));
  }

  async gitStatus() {
    return this.readWithRecovery(async (record) => {
      await this.app.reconcileGitState(record);
      return this.app.gitStatus(record);
    });
  }

  async proveWorkspaceState() {
    return this.readWithRecovery((record) => this.app.proveWorkspaceState(record));
  }

  async checkpoint(input: { name?: string }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        this.assertCheckpointQuiescent(record);
        return await this.app.checkpoint(record, input.name);
      } finally {
        await this.save(record);
      }
    });
  }

  async exportRecoveryPatch(input: { maxBytes: number }) {
    return this.readWithRecovery((record) => this.app.exportRecoveryPatch(record, input.maxBytes));
  }

  async restoreCheckpoint(input: { snapshotId: string; expectedRevision?: number }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        this.assertCheckpointQuiescent(record);
        const source = await repositoryCloneSource(this.env, record.workspace);
        return await this.app.restoreCheckpoint(
          record,
          input.snapshotId as Parameters<ForgeApplicationService['restoreCheckpoint']>[1],
          input.expectedRevision,
          source
        );
      } finally {
        await this.save(record);
      }
    });
  }

  async gitDiff(input: { staged: boolean }) {
    return this.readWithRecovery(async (record) => {
      await this.app.reconcileGitState(record);
      return this.app.gitDiff(record, input.staged);
    });
  }

  async gitBranchCreate(input: { branch: string; expectedRevision?: number; idempotencyKey: string }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        this.assertCheckpointQuiescent(record);
        await this.app.reconcileGitState(record);
        const value = await this.app.gitBranchCreate(record, input.branch, input.expectedRevision, input.idempotencyKey);
        const checkpoint = await this.app.checkpoint(record, `branch-${record.workspace.currentBranch ?? record.workspace.revision}`);
        return { ...value, checkpoint };
      } finally {
        await this.save(record);
      }
    });
  }

  async gitCommit(input: { message: string; paths: string[]; expectedRevision?: number; idempotencyKey: string }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        this.assertCheckpointQuiescent(record);
        await this.app.reconcileGitState(record);
        const value = await this.app.gitCommit(record, input);
        const checkpoint = await this.app.checkpoint(record, `commit-${record.workspace.currentCommit ?? record.workspace.revision}`);
        return { ...value, checkpoint };
      } finally {
        await this.save(record);
      }
    });
  }

  async gitOutgoingDiff(input: { base: string }) {
    return this.readWithRecovery(async (record) => {
      await this.app.reconcileGitState(record);
      return this.app.gitOutgoingDiff(record, input.base);
    });
  }

  async gitPush(input: { branch: string; base: string; expectedDiffHash: string; expectedRevision?: number; idempotencyKey: string }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        await this.app.reconcileGitState(record);
        const source = await repositoryPushSource(this.env, record.workspace, input.branch, record.workspace.currentCommit ?? '');
        return await this.app.gitPush(record, { ...input, source });
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
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        await this.app.reconcileGitState(record);
        const source = await repositoryCloneSource(this.env, record.workspace);
        await this.app.assertDestroySafe(record, source);
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

  async completeDestroy() {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        const source = await repositoryCloneSource(this.env, record.workspace);
        const value = await this.app.completeDestroy(record, source);
        await this.ctx.storage.delete(LEASE_KEY);
        return value;
      } finally {
        await this.save(record);
      }
    });
  }
}
