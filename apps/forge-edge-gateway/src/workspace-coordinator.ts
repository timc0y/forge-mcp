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
    try {
      await this.app.assertCheckoutPresent(record);
    } catch (error) {
      await this.save(record);
      throw error;
    }
    return record;
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
    const work: Array<Promise<unknown>> = [this.ctx.storage.put(RECORD_KEY, record)];
    if (writeD1) {
      work.push(this.metadata.putWorkspace(workspace));
      this.lastD1 = { signature, atMs: now };
    }
    await Promise.all(work);
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

  async getState() {
    const record = await this.getRecord();
    const lease = await this.ctx.storage.get<MutationLease>(LEASE_KEY);
    return {
      ...record.workspace,
      processes: record.processes,
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
      lease:
        lease && Date.parse(lease.expiresAt) > Date.now()
          ? { holder: lease.holder, expiresAt: lease.expiresAt }
          : null
    };
  }

  async filesTree(input: { path: string; depth: number; limit: number }) {
    return this.app.tree(await this.repoRecord(), input);
  }

  async filesRead(input: {
    path: string;
    startLine?: number;
    endLine?: number;
    maxBytes: number;
  }) {
    return this.app.read(await this.repoRecord(), input);
  }

  async filesPatch(input: {
    patch: string;
    expectedRevision?: number;
    idempotencyKey: string;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.repoRecord();
      const value = await this.app.patch(
        record,
        { patch: input.patch, cwd: '/workspace/repo' },
        input.expectedRevision,
        input.idempotencyKey
      );
      await this.save(record);
      return value;
    });
  }

  async filesWrite(input: {
    path: string;
    content: string;
    expectedSha256?: string;
    expectedRevision?: number;
    idempotencyKey: string;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.repoRecord();
      const value = await this.app.write(
        record,
        { path: input.path, content: input.content, expectedSha256: input.expectedSha256 },
        input.expectedRevision,
        input.idempotencyKey
      );
      await this.save(record);
      return value;
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
    const decisionRequiresSerialization = input.idempotencyKey !== undefined;
    const touchesRepo = input.cwd === '/workspace/repo' || input.cwd.startsWith('/workspace/repo/');
    const action = async () => {
      const record = touchesRepo ? await this.repoRecord() : await this.getRecord();
      const before = record.workspace.revision;
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
      if (record.workspace.revision !== before) await this.save(record);
      return value;
    };
    return decisionRequiresSerialization ? this.serializeMutation(action) : action();
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
      const value = await this.app.startProcess(record, input);
      await this.save(record);
      return value;
    });
  }

  async processLogs(input: { processId: ProcessId; cursor?: string }) {
    return this.app.processLogs(
      await this.getRecord(),
      input.processId,
      input.cursor
    );
  }

  async gitStatus() {
    return this.app.gitStatus(await this.repoRecord());
  }

  async gitDiff(input: { staged: boolean }) {
    return this.app.gitDiff(await this.repoRecord(), input.staged);
  }

  async gitBranchCreate(input: { branch: string; expectedRevision?: number; idempotencyKey: string }) {
    return this.serializeMutation(async () => {
      const record = await this.repoRecord();
      const value = await this.app.gitBranchCreate(record, input.branch, input.expectedRevision, input.idempotencyKey);
      await this.save(record);
      return value;
    });
  }

  async gitCommit(input: { message: string; paths: string[]; expectedRevision?: number; idempotencyKey: string }) {
    return this.serializeMutation(async () => {
      const record = await this.repoRecord();
      const value = await this.app.gitCommit(record, input);
      await this.save(record);
      return value;
    });
  }

  async gitOutgoingDiff(input: { base: string }) {
    return this.app.gitOutgoingDiff(await this.repoRecord(), input.base);
  }

  async gitPush(input: { branch: string; base: string; expectedDiffHash: string; expectedRevision?: number; idempotencyKey: string }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      const source = await repositoryPushSource(this.env, record.workspace, input.branch, record.workspace.currentCommit ?? '');
      const value = await this.app.gitPush(record, { ...input, source });
      await this.save(record);
      return value;
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
      const value = await this.app.exposePreview(record, input);
      await this.save(record);
      return value;
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
      const value = this.app.requestDestroy(
        record,
        input.expectedRevision,
        input.idempotencyKey
      );
      await this.save(record);
      return value;
    });
  }

  async completeDestroy() {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      const value = await this.app.completeDestroy(record);
      await this.save(record);
      await this.ctx.storage.delete(LEASE_KEY);
      return value;
    });
  }
}
