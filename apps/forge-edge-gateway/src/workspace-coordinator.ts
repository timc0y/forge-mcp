import { DurableObject } from 'cloudflare:workers';
import {
  ForgeApplicationService,
  type CreateWorkspaceInput,
  type WorkspaceRuntimeRecord
} from '@forge/application';
import { ForgeError, type ProcessId } from '@forge/core';
import { D1AuditStore } from '@forge/audit';
import { D1MetadataStore } from '@forge/metadata-d1';
import type { NetworkPolicyMode } from '@forge/sandbox-core';
import { issueCapability } from '@forge/capabilities';
import type { Env } from './env';
import { createSandboxRouter } from './sandbox-router-env';
import { repositoryCloneSource, repositoryPushSource } from './github';
import { snapshotsEnabled, getSnapshot } from './snapshots';
import { depsCacheKey, getDepsCache } from './deps-cache';

const RECORD_KEY = 'workspace-runtime';
// Legacy key from a removed mutation-lease mechanism; still cleared on destroy.
const LEASE_KEY = 'mutation-lease';
// How long a healthy checkout probe result stays trusted before repoRecord()
// re-runs the `test -d .git` container round-trip. During bursts of repo-scoped
// tool calls this collapses the redundant PRE-probe; the downstream self-heal
// still fires if a checkout vanishes within the window.
const CHECKOUT_PROBE_TTL_MS = 60_000;

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
  // The full-workspace snapshot and the per-repo deps cache both tar large trees
  // (~100MB+ each) from the same container after bootstrap. Running them at once
  // contends on container disk/CPU and one loses, so they chain onto this shared
  // promise to upload sequentially instead of concurrently.
  private pendingUpload: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.app = new ForgeApplicationService(createSandboxRouter(env));
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
      // Self-heal: an idle recycle can drop /workspace/repo. Try to bring the
      // checkout back (snapshot restore, then a fresh clone) before surfacing
      // the failure. A fresh-clone recovery that had to discard real
      // unpushed work throws FORGE_CHECKOUT_DATA_LOSS — that must reach the
      // caller loudly, not be swallowed as an ordinary self-heal success, so
      // save the (now-recovered) record either way and propagate it.
      try {
        await this.recoverCheckout(record);
        await this.save(record);
        return record;
      } catch (recoveryError) {
        await this.save(record);
        if (recoveryError instanceof ForgeError && recoveryError.code === 'FORGE_CHECKOUT_DATA_LOSS') {
          await new D1AuditStore(this.env.METADATA)
            .append({
              schemaVersion: 1,
              id: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
              tenantId: record.workspace.tenantId,
              workspaceId: record.workspace.id,
              actor: { type: 'service', id: 'workspace-coordinator' },
              type: 'workspace.checkout_data_loss',
              occurredAt: new Date().toISOString(),
              payload: { detail: record.workspace.dataLoss?.detail, branch: record.workspace.currentBranch }
            })
            .catch(() => undefined);
          throw recoveryError;
        }
        throw error;
      }
    }
    return record;
  }

  // Attempt in-place recovery of a missing repository checkout. assertCheckoutPresent
  // has already flipped the record to `failed`; we optimistically restore `ready`
  // so the handle-gated restore path can run. Throws on total failure, and also
  // throws FORGE_CHECKOUT_DATA_LOSS (record still mutated to a usable `ready`
  // state) when the only available recovery path lost real unpushed work.
  private async recoverCheckout(record: WorkspaceRuntimeRecord): Promise<void> {
    record.workspace.state = 'ready';
    // 1. Best-effort snapshot restore of the whole /workspace tar — lossless
    // when it works, since it's a filesystem-level restore, not a re-clone.
    try {
      const snap = await this.restoreFromR2();
      if (snap.restored) {
        await this.app.assertCheckoutPresent(record);
        record.workspace.failure = undefined;
        return;
      }
    } catch {
      // fall through to a fresh clone
    }
    // 2. Fresh clone — may throw FORGE_CHECKOUT_DATA_LOSS; let it propagate.
    const cloneSource = await repositoryCloneSource(this.env, record.workspace);
    await this.app.recoverCheckout(record, cloneSource);
  }

  private async save(record: WorkspaceRuntimeRecord): Promise<void> {
    const workspace = record.workspace;
    // Fields the reaper/dashboard actually read. A change to any of these — or a
    // stale debounce window — forces the D1 write; otherwise it is skipped.
    const signature = `${workspace.state}|${workspace.currentCommit ?? ''}|${workspace.currentBranch ?? ''}|${workspace.hasUnpushedWork ? 1 : 0}`;
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
      // The D1 snapshot lookup and the GitHub token fetch are independent of each
      // other and of container boot — start them together. The token fetch can throw,
      // so it is only awaited inside the try below where its failure is handled.
      const cloneSourcePromise = repositoryCloneSource(this.env, record.workspace);
      // If a prior snapshot exists, let provisioning restore it and skip the slow
      // clone+install. Best-effort — a failed restore falls back to full bootstrap.
      const priorSnapshot = await getSnapshot(this.env.METADATA, record.workspace.id).catch(() => null);
      const restore = priorSnapshot
        ? () => this.restoreFromR2().then((r) => r.restored).catch(() => false)
        : undefined;
      // Per-repo dependency cache hooks (content-keyed, shared across workspaces of
      // the same repo+lockfile). Gated on the same snapshot flag and fully
      // best-effort — a failure in either hook never blocks provisioning.
      const repoSlug = `${record.workspace.repository.owner}/${record.workspace.repository.name}`;
      const runtime = record.workspace.runtimeProfile;
      // Scope the deps cache to the tenant: node_modules is executable, so a
      // shared cross-tenant tree would let one tenant run another's code.
      const tenantId = record.workspace.tenantId;
      const depsCache = snapshotsEnabled(this.env)
        ? {
            restore: (lockfileHash: string) =>
              this.restoreDepsFromR2(depsCacheKey(tenantId, repoSlug, lockfileHash, runtime).cacheKey).catch(() => false),
            populate: (lockfileHash: string) => {
              const { cacheKey } = depsCacheKey(tenantId, repoSlug, lockfileHash, runtime);
              console.log('forge_deps_populate_called', { cacheKey });
              // Chain so the post-bootstrap snapshot uploads after this, not with it.
              this.pendingUpload = this.pendingUpload
                .then(() => this.depsToR2(cacheKey))
                .then((r) => console.log('forge_deps_upload_result', { cacheKey, ...r }))
                .catch((e) => console.log('forge_deps_upload_threw', { cacheKey, error: String(e).slice(0, 200) }));
              this.ctx.waitUntil(this.pendingUpload);
            }
          }
        : undefined;
      try {
        const cloneSource = await cloneSourcePromise;
        await this.app.provisionWorkspace(
          record,
          input.bootstrap,
          (next) => this.save(next),
          cloneSource,
          restore,
          depsCache
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
      // After a full bootstrap (no snapshot to restore from) capture one now so a
      // mid-life eviction — not just a graceful reap — comes back warm. Fire-and-
      // forget: never let snapshotting delay or fail readiness.
      if (!priorSnapshot) {
        // Chain after any deps-cache upload so the two large tars don't contend.
        this.pendingUpload = this.pendingUpload.then(() => this.snapshotToR2().catch(() => undefined));
        this.ctx.waitUntil(this.pendingUpload);
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
      )
    };
  }

  // Mint a short-lived capability scoped to this workspace's snapshot endpoint,
  // so untrusted container code can only PUT/GET its own snapshot.
  private async snapshotToken(workspaceId: string, tenantId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return issueCapability(
      { version: 1, subject: 'forge-snapshot', tenantId, workspaceId, action: `snapshot:${workspaceId}`, nonce: crypto.randomUUID(), issuedAt: now, expiresAt: now + 900 },
      this.env.FORGE_CAPABILITY_SIGNING_KEY
    );
  }

  // snapshot_on_idle: tar /workspace and stream it (from inside the container) to
  // the Worker's R2 snapshot gateway. Best-effort and gated — a failure never
  // blocks teardown. Must run while the workspace is still ready (before destroy).
  async snapshotToR2(): Promise<{ snapshotted: boolean; reason?: string }> {
    if (!snapshotsEnabled(this.env)) return { snapshotted: false, reason: 'disabled' };
    let record: WorkspaceRuntimeRecord;
    try {
      record = await this.getRecord();
    } catch {
      return { snapshotted: false, reason: 'no-record' };
    }
    if (!['ready', 'busy'].includes(record.workspace.state)) return { snapshotted: false, reason: `state ${record.workspace.state}` };
    try {
      const workspaceId = record.workspace.id;
      const token = await this.snapshotToken(workspaceId, record.workspace.tenantId);
      const url = `${this.env.FORGE_PUBLIC_ORIGIN}/__forge_snapshot/${workspaceId}`;
      const handle = await this.app.handle(record);
      // Chunked multipart upload: split the tar into <100MB parts so each
      // request stays under the Cloudflare edge inbound-body limit. The single
      // -shot PUT path still exists on the gateway as a fallback for small tars.
      const command = [
        'set -e',
        `U=${JSON.stringify(url)}`,
        `T=${JSON.stringify(token)}`,
        'D=$(mktemp -d)',
        `tar czf - -C /workspace --exclude=./tmp --exclude='./repo/node_modules/.cache' . | split -b 80m -d -a 4 - "$D/p"`,
        `UP=$(curl -sf -X POST -H "authorization: Bearer $T" "$U?mp=create")`,
        'i=0; PARTS=""',
        `for f in "$D"/p*; do i=$((i+1)); E=$(curl -sf -X PUT --data-binary @"$f" -H "authorization: Bearer $T" "$U?mp=part&uploadId=$UP&part=$i"); PARTS="$PARTS$i:$E\\n"; done`,
        `printf "%b" "$PARTS" | curl -sf -X POST --data-binary @- -H "authorization: Bearer $T" "$U?mp=complete&uploadId=$UP"`,
        'rm -rf "$D"'
      ].join('\n');
      const result = await handle.exec({ command, cwd: '/workspace', timeoutMs: 300_000, outputLimitBytes: 20_000, sessionId: 'system', networkPolicy: 'development' });
      return { snapshotted: result.exitCode === 0, reason: result.exitCode === 0 ? undefined : result.stderr.slice(0, 200) };
    } catch (error) {
      return { snapshotted: false, reason: error instanceof Error ? error.message.slice(0, 200) : 'error' };
    }
  }

  // Restore a prior snapshot over a freshly provisioned workspace (best-effort).
  async restoreFromR2(): Promise<{ restored: boolean }> {
    if (!snapshotsEnabled(this.env)) return { restored: false };
    let record: WorkspaceRuntimeRecord;
    try {
      record = await this.getRecord();
    } catch {
      return { restored: false };
    }
    const snap = await getSnapshot(this.env.METADATA, record.workspace.id).catch(() => null);
    if (!snap) return { restored: false };
    try {
      const workspaceId = record.workspace.id;
      const token = await this.snapshotToken(workspaceId, record.workspace.tenantId);
      const url = `${this.env.FORGE_PUBLIC_ORIGIN}/__forge_snapshot/${workspaceId}`;
      const handle = await this.app.handle(record);
      const command = `curl -sf -H ${JSON.stringify(`authorization: Bearer ${token}`)} ${JSON.stringify(url)} | tar xzf - -C /workspace`;
      const result = await handle.exec({ command, cwd: '/workspace', timeoutMs: 300_000, outputLimitBytes: 20_000, sessionId: 'system', networkPolicy: 'development' });
      return { restored: result.exitCode === 0 };
    } catch {
      return { restored: false };
    }
  }

  // Mint a short-lived capability scoped to one deps cache_key, so untrusted
  // container code can only PUT/GET that exact content-keyed cache entry.
  private async depsToken(workspaceId: string, tenantId: string, cacheKey: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return issueCapability(
      { version: 1, subject: 'forge-deps', tenantId, workspaceId, action: `deps:${cacheKey}`, nonce: crypto.randomUUID(), issuedAt: now, expiresAt: now + 900 },
      this.env.FORGE_CAPABILITY_SIGNING_KEY
    );
  }

  // Restore the shared dependency dirs (node_modules / .venv) for this repo's
  // lockfile from R2 into /workspace/repo. Best-effort and gated — a miss or
  // failure just falls back to a normal install.
  async restoreDepsFromR2(cacheKey: string): Promise<boolean> {
    if (!snapshotsEnabled(this.env)) return false;
    let record: WorkspaceRuntimeRecord;
    try {
      record = await this.getRecord();
    } catch {
      return false;
    }
    const row = await getDepsCache(this.env.METADATA, cacheKey).catch(() => null);
    if (!row) return false;
    try {
      const workspaceId = record.workspace.id;
      const token = await this.depsToken(workspaceId, record.workspace.tenantId, cacheKey);
      const url = `${this.env.FORGE_PUBLIC_ORIGIN}/__forge_deps/${workspaceId}`;
      const handle = await this.app.handle(record);
      const command = `curl -sf -H ${JSON.stringify(`authorization: Bearer ${token}`)} -H ${JSON.stringify(`x-forge-deps-key: ${cacheKey}`)} ${JSON.stringify(url)} | tar xzf - -C /workspace/repo`;
      const result = await handle.exec({ command, cwd: '/workspace/repo', timeoutMs: 300_000, outputLimitBytes: 20_000, sessionId: 'system', networkPolicy: 'development' });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // Populate the shared dependency cache from a freshly installed /workspace/repo:
  // tar every node_modules dir (and .venv if present) and stream it to the deps
  // gateway, which records the D1 row on PUT. Best-effort and gated.
  async depsToR2(cacheKey: string): Promise<{ cached: boolean; reason?: string }> {
    if (!snapshotsEnabled(this.env)) return { cached: false, reason: 'disabled' };
    let record: WorkspaceRuntimeRecord;
    try {
      record = await this.getRecord();
    } catch {
      return { cached: false, reason: 'no-record' };
    }
    if (!['ready', 'busy', 'bootstrapping'].includes(record.workspace.state)) return { cached: false, reason: `state ${record.workspace.state}` };
    try {
      const workspaceId = record.workspace.id;
      const token = await this.depsToken(workspaceId, record.workspace.tenantId, cacheKey);
      const url = `${this.env.FORGE_PUBLIC_ORIGIN}/__forge_deps/${workspaceId}`;
      const handle = await this.app.handle(record);
      // Same chunked multipart flow as snapshotToR2, preserving the node_modules
      // /.venv path discovery. Each part is its own <100MB request.
      const command = [
        'set -e',
        `U=${JSON.stringify(url)}`,
        `T=${JSON.stringify(token)}`,
        `K=${JSON.stringify(cacheKey)}`,
        'paths=$(find . -type d -name node_modules -prune 2>/dev/null)',
        'if [ -d .venv ]; then paths="$paths .venv"; fi',
        'if [ -z "$paths" ]; then exit 0; fi',
        'D=$(mktemp -d)',
        'tar czf - $paths | split -b 80m -d -a 4 - "$D/p"',
        `UP=$(curl -sf -X POST -H "authorization: Bearer $T" -H "x-forge-deps-key: $K" "$U?mp=create")`,
        'i=0; PARTS=""',
        `for f in "$D"/p*; do i=$((i+1)); E=$(curl -sf -X PUT --data-binary @"$f" -H "authorization: Bearer $T" -H "x-forge-deps-key: $K" "$U?mp=part&uploadId=$UP&part=$i"); PARTS="$PARTS$i:$E\\n"; done`,
        `printf "%b" "$PARTS" | curl -sf -X POST --data-binary @- -H "authorization: Bearer $T" -H "x-forge-deps-key: $K" "$U?mp=complete&uploadId=$UP"`,
        'rm -rf "$D"'
      ].join('\n');
      const result = await handle.exec({ command, cwd: '/workspace/repo', timeoutMs: 300_000, outputLimitBytes: 20_000, sessionId: 'system', networkPolicy: 'development' });
      return { cached: result.exitCode === 0, reason: result.exitCode === 0 ? undefined : result.stderr.slice(0, 200) };
    } catch (error) {
      return { cached: false, reason: error instanceof Error ? error.message.slice(0, 200) : 'error' };
    }
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
    // idempotency_key is required by the tool schema, so every shellExec
    // serializes — no dead "fast path".
    const touchesRepo = input.cwd === '/workspace/repo' || input.cwd.startsWith('/workspace/repo/');
    return this.serializeMutation(async () => {
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
    });
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

  async gitIsAncestor(input: { ancestor: string }) {
    return this.app.gitIsAncestor(await this.repoRecord(), input.ancestor);
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
    force?: boolean;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      const value = this.app.requestDestroy(
        record,
        input.expectedRevision,
        input.idempotencyKey,
        input.force
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
