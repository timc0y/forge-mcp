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
    return record;
  }

  private async save(record: WorkspaceRuntimeRecord): Promise<void> {
    await Promise.all([
      this.ctx.storage.put(RECORD_KEY, record),
      this.metadata.putWorkspace(record.workspace)
    ]);
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
    state: string;
    revision: number;
  }> {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      if (record.workspace.state === 'ready') {
        return {
          state: record.workspace.state,
          revision: record.workspace.revision
        };
      }
      try {
        await this.app.provisionWorkspace(record, input.bootstrap, (next) =>
          this.save(next)
        );
      } catch (error) {
        await this.save(record);
        throw error;
      }
      return {
        state: record.workspace.state,
        revision: record.workspace.revision
      };
    });
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
    return this.app.tree(await this.getRecord(), input);
  }

  async filesRead(input: {
    path: string;
    startLine?: number;
    endLine?: number;
    maxBytes: number;
  }) {
    return this.app.read(await this.getRecord(), input);
  }

  async filesPatch(input: {
    patch: string;
    expectedRevision?: number;
    idempotencyKey: string;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
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
    const action = async () => {
      const record = await this.getRecord();
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
    return this.app.gitStatus(await this.getRecord());
  }

  async gitDiff(input: { staged: boolean }) {
    return this.app.gitDiff(await this.getRecord(), input.staged);
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
    return { workspace: record.workspace, preview };
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
