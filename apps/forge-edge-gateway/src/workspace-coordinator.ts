import { DurableObject } from 'cloudflare:workers';
import {
  ForgeApplicationService,
  dependencyStateView,
  managedProcessStatus,
  workspaceAllowedNextActions,
  type CreateWorkspaceInput,
  type WorkspaceRuntimeRecord
} from '@forge/application';
import { ForgeError, type OperationId, type ProcessId } from '@forge/core';
import { D1AuditStore } from '@forge/audit';
import { D1MetadataStore } from '@forge/metadata-d1';
import type { NetworkPolicyMode } from '@forge/sandbox-core';
import { issueCapability } from '@forge/capabilities';
import { classifyCommand, nonInteractiveShellEnv } from '@forge/policy';
import type { Env } from './env';
import { createSandboxRouter } from './sandbox-router-env';
import { repositoryCloneSource, repositoryPushSource } from './github';
import { autoPushForgeBranchesEnabled, isAgentForgeBranch } from './auto-push-policy';
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
    return { ...record, snapshots: record.snapshots ?? {}, checks: record.checks ?? {} };
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
    const writes: Array<Promise<unknown>> = [this.ctx.storage.put(RECORD_KEY, record)];
    if (writeD1) writes.push(this.metadata.putWorkspace(workspace));
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
    if (writeD1) this.lastD1 = { signature, atMs: now };
  }

  private async assertCheckpointQuiescent(record: WorkspaceRuntimeRecord): Promise<void> {
    // Reap finished processes first. Otherwise a completed install/probe keeps
    // blocking reads and writes forever with "stop workspace-owned processes".
    await this.app.syncProcessLifecycle(record);
    const active = Object.entries(record.processes)
      .filter(([, entry]) => !entry.completedAt)
      .map(([id, entry]) => ({
        id,
        command: entry.command.slice(0, 200),
        status: 'running',
        mutatesFilesystem: entry.mutatesFilesystem,
        startedAt: entry.startedAt
      }));
    if (active.length > 0) {
      const recommendedWait = active.find((process) =>
        /\b(pnpm|npm|yarn|bun|pip|uv)\b/i.test(process.command) &&
        /\b(install|ci|sync)\b/i.test(process.command)
      );
      const recommendedStop = active.find((process) => process.id !== recommendedWait?.id);
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_CONFLICT',
        message: 'Stop or wait for workspace-owned processes before a filesystem mutation or checkpoint so Forge can capture an immutable recovery snapshot.',
        retryable: true,
        details: {
          status: 'blocked',
          reason: 'active_process',
          processIds: active.map((process) => process.id),
          processes: active,
          ...(recommendedWait
            ? { recommendedWaitProcessId: recommendedWait.id, recommendedAction: 'forge_process_wait' }
            : {}),
          ...(recommendedStop && !recommendedWait
            ? { recommendedStopProcessId: recommendedStop.id, recommendedAction: 'forge_process_stop' }
            : {}),
          allowedNextActions: [
            'forge_process_wait',
            'forge_process_list',
            'forge_process_list',
            'forge_process_stop',
            'forge_process_stop'
          ]
        }
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

  async getState(options: { compact?: boolean } = {}) {
    return this.readWithRecovery(async (record) => {
      if (['ready', 'busy'].includes(record.workspace.state) && await this.app.reconcileGitState(record)) await this.save(record);
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
          recommendedAction: 'The recorded Git state differs from the filesystem. Do not restore a checkpoint — inspect manually.',
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
          revision: record.workspace.revision,
          hasUnpushedWork: record.workspace.hasUnpushedWork,
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
          lastChecks: Object.entries(record.checks)
            .slice(-5)
            .map(([id, check]) => ({
              processId: id,
              name: check.name,
              exitCode: check.exitCode,
              completedAt: check.completedAt,
              startedAt: check.startedAt
            })),
          allowedNextActions,
          next_step: allowedNextActions[0]
            ? `Next safe tool: ${allowedNextActions[0]}`
            : 'Inspect forge_workspace_get for details.'
        };
      }
      return {
        ...record.workspace,
        processes,
        checks: record.checks,
        lastChecks: Object.entries(record.checks)
          .slice(-5)
          .map(([id, check]) => ({
            processId: id,
            name: check.name,
            exitCode: check.exitCode,
            completedAt: check.completedAt,
            startedAt: check.startedAt
          })),
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
        gitIntegrity,
        dependencyState,
        activeProcessIds,
        allowedNextActions,
        next_step: allowedNextActions[0]
          ? `Next safe tool: ${allowedNextActions[0]}`
          : 'Inspect forge_workspace_get for details.',
        ...(record.lastRecoveryVerifiedAt
          ? {
              recovery: {
                verifiedAt: record.lastRecoveryVerifiedAt,
                snapshotId: record.workspace.activeSnapshotId ?? null
              }
            }
          : {})
      };
    });
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
    return this.readRepoWithRecovery((record) => this.app.tree(record, input));
  }

  async filesRead(input: {
    path: string;
    startLine?: number;
    endLine?: number;
    maxBytes: number;
  }) {
    return this.readRepoWithRecovery((record) => this.app.read(record, input));
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
      try {
        await this.assertCheckpointQuiescent(record);
        const value = await this.app.write(
          record,
          { path: input.path, content: input.content, expectedSha256: input.expectedSha256 },
          input.expectedRevision,
          input.idempotencyKey
        );
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
      const record = await this.repoRecord();
      try {
        await this.assertCheckpointQuiescent(record);
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
    mode?: 'read_only' | 'mutating';
  }) {
    const shellDecision = classifyCommand(input.command, input.networkPolicy);
    if (input.mode === 'read_only' && shellDecision.classification !== 'read_only') {
      throw new ForgeError({
        code: 'FORGE_VALIDATION_FAILED',
        message: 'mode:read_only was requested but the command is classified as mutating; refuse to run it without a mutation path.',
        retryable: false,
        details: { classification: shellDecision.classification, allowedNextActions: ['forge_shell'] }
      });
    }
    const forcedReadOnly = input.mode === 'read_only' || shellDecision.classification === 'read_only';
    // Pure read-only probes skip the mutation lock so they are not blocked by
    // another process's snapshot/serialize queue, and never create checkpoints.
    if (forcedReadOnly) {
      return this.readWithRecovery(async (record) => {
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
          head: record.workspace.currentCommit,
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
        // Mutating commands sync/reap finished processes before the quiescent check.
        if (input.idempotencyKey) {
          await this.assertCheckpointQuiescent(record);
        }
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
        const checkpoint = await this.app.checkpoint(record, `shell-${record.workspace.revision}`);
        return { ...value, checkpoint, mode: 'mutating' as const };
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
    const timeoutMs = input.timeoutMs ?? 120_000;
    const sliceMs = 5_000;
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
        suggestedTimeoutMs: Math.min(600_000, Math.max(timeoutMs * 2, 300_000)),
        next_step: `Process ${input.processId} is still running after ${timeoutMs}ms. Retry forge_process_wait with timeout_ms >= ${Math.min(600_000, Math.max(timeoutMs * 2, 300_000))} (use 600000 for large installs). Do not restart the install.`
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
      hasUnpushedWork: boolean;
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
          hasUnpushedWork: Boolean(record.workspace.hasUnpushedWork),
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

  async reconcile() {
    return this.readRepoWithRecovery(async (record) => {
      const result = await this.app.reconcileWorkspace(record);
      return result;
    });
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
        const result = await this.app.dependenciesInstall(record, input);
        return result;
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
    return this.readRepoWithRecovery(async (record) => {
      await this.app.reconcileGitState(record);
      return this.app.gitStatus(record);
    });
  }

  async checkpoint(input: { name?: string }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        await this.assertCheckpointQuiescent(record);
        return await this.app.checkpoint(record, input.name);
      } finally {
        await this.save(record);
      }
    });
  }

  async exportRecoveryPatch(input: { maxBytes: number }) {
    return this.readRepoWithRecovery((record) => this.app.exportRecoveryPatch(record, input.maxBytes));
  }

  async restoreCheckpoint(input: { snapshotId: string; expectedRevision?: number }) {
    return this.serializeMutation(async () => {
      const record = await this.repoRecord();
      try {
        await this.assertCheckpointQuiescent(record);
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

  async gitDiff(input: { staged: boolean; cursor?: number; maxBytes?: number; paths?: string[] }) {
    return this.readRepoWithRecovery(async (record) => {
      await this.app.reconcileGitState(record);
      return this.app.gitDiff(record, input.staged, {
        cursor: input.cursor,
        maxBytes: input.maxBytes,
        paths: input.paths
      });
    });
  }

  async gitBranchCreate(input: { branch: string; expectedRevision?: number; idempotencyKey: string }) {
    return this.serializeMutation(async () => {
      const record = await this.repoRecord();
      try {
        await this.assertCheckpointQuiescent(record);
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
      const record = await this.repoRecord();
      try {
        await this.assertCheckpointQuiescent(record);
        await this.assertRemoteNotBlocking(record);
        await this.app.reconcileGitState(record);
        const value = await this.app.gitCommit(record, input);
        const autoPush = await this.tryAutoPushAfterCommit(record);
        const checkpoint = await this.app.checkpoint(record, `commit-${record.workspace.currentCommit ?? record.workspace.revision}`);
        return { ...value, ...autoPush, checkpoint };
      } finally {
        await this.save(record);
      }
    });
  }

  private assertRemoteNotBlocking(record: WorkspaceRuntimeRecord): void {
    if (record.workspace.gitRemoteDivergence) {
      throw new ForgeError({
        code: 'FORGE_WORKSPACE_CONFLICT',
        message: 'Remote branch diverged from workspace HEAD. Call forge_git_sync before mutating the repository.',
        retryable: false,
        details: record.workspace.gitRemoteDivergence
      });
    }
  }

  async tryAutoPushAfterCommit(record: WorkspaceRuntimeRecord): Promise<{
    auto_push?: { pushed: boolean; remote_sha?: string; causeClass?: string; reason?: string };
  }> {
    if (!autoPushForgeBranchesEnabled(this.env) || !isAgentForgeBranch(record.workspace.currentBranch)) {
      return { auto_push: { pushed: false, reason: 'disabled' } };
    }
    const branch = record.workspace.currentBranch!;
    const commit = record.workspace.currentCommit ?? '';
    if (!commit) return { auto_push: { pushed: false, reason: 'no commit' } };
    let source: { url: string; authorizationHeader: string };
    try {
      source = await repositoryPushSource(this.env, record.workspace, branch, commit);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'no authorization';
      return { auto_push: { pushed: false, reason: message, causeClass: 'auth' } };
    }
    const result = await this.app.autoPushForgeBranch(record, source);
    return {
      auto_push: {
        pushed: result.pushed,
        remote_sha: result.remote_sha,
        causeClass: result.causeClass,
        reason: result.reason
      }
    };
  }

  async durablePushBeforeTeardown(): Promise<{
    pushed: boolean;
    ref?: string;
    branch?: string;
    remote_sha?: string;
    reason?: string;
    causeClass?: string;
  }> {
    const record = await this.getRecord();
    if (autoPushForgeBranchesEnabled(this.env) && isAgentForgeBranch(record.workspace.currentBranch)) {
      const branch = record.workspace.currentBranch!;
      const commit = record.workspace.currentCommit ?? '';
      if (commit) {
        try {
          const source = await repositoryPushSource(this.env, record.workspace, branch, commit);
          const persisted = await this.app.persistAgentBranchToRemote(record, source, {
            idempotencyKey: `teardown-${record.workspace.id}-${record.workspace.revision}`
          });
          await this.save(record);
          if (persisted.pushed) {
            return { pushed: true, branch: persisted.branch, remote_sha: persisted.commit, ref: persisted.branch };
          }
        } catch {
          // fall through to backup ref
        }
      }
    }
    return this.backupUnpushedWork();
  }

  async recordPushAuthProbe(): Promise<{ ok: boolean; reason?: string }> {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      let ok = false;
      let reason: string | undefined;
      try {
        const branch = record.workspace.currentBranch ?? 'forge/probe-auth';
        const commit = record.workspace.currentCommit ?? '0'.repeat(40);
        await repositoryPushSource(this.env, record.workspace, branch, commit);
        ok = true;
      } catch (error) {
        reason = error instanceof Error ? error.message.slice(0, 300) : 'push authorization unavailable';
      }
      record.workspace.pushAuthProbe = { ok, checkedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
      await this.save(record);
      return { ok, ...(reason ? { reason } : {}) };
    });
  }

  async gitSyncRemote(input: { action: 'detect' | 'reset_to_remote' | 'keep_local_and_push' }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      const source = await repositoryCloneSource(this.env, record.workspace);
      const value = await this.app.gitSyncRemote(record, source, input.action);
      await this.save(record);
      return value;
    });
  }

  async proveWorkspaceState() {
    return this.readRepoWithRecovery(async (record) => {
      let source: Awaited<ReturnType<typeof repositoryCloneSource>> | undefined;
      try {
        source = await repositoryCloneSource(this.env, record.workspace);
      } catch {
        source = undefined;
      }
      return this.app.proveWorkspaceState(record, source);
    });
  }

  async gitOutgoingDiff(input: { base: string; cursor?: number; maxBytes?: number; paths?: string[] }) {
    return this.readRepoWithRecovery(async (record) => {
      await this.app.reconcileGitState(record);
      return this.app.gitOutgoingDiff(record, input.base, {
        cursor: input.cursor,
        maxBytes: input.maxBytes,
        paths: input.paths
      });
    });
  }

  async gitOutgoingPaths(input: { base: string }) {
    return this.readRepoWithRecovery(async (record) => {
      await this.app.reconcileGitState(record);
      return this.app.gitOutgoingPaths(record, input.base);
    });
  }

  async gitIsAncestor(input: { ancestor: string }) {
    return this.readRepoWithRecovery(async (record) => {
      await this.app.reconcileGitState(record);
      return this.app.gitIsAncestor(record, input.ancestor);
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

  /**
   * Park the current branch on a Forge-owned staging ref so a submission can wait
   * for a human decision without holding this workspace open. Returns the commit
   * the staging ref now points at, which is what the deferred action replays onto
   * the real branch once the human approves.
   *
   * Needs no approval of its own: `forge/staged/…` is Forge's namespace, no pull
   * request exists yet, and nothing the user considers their branch has moved.
   */
  async stageForReview(input: { ref: string }): Promise<{ ref: string; commit: string }> {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      const commit = record.workspace.currentCommit;
      if (!record.workspace.currentBranch || !commit) {
        throw new ForgeError({
          code: 'FORGE_VALIDATION_FAILED',
          message: 'Nothing to submit: commit your work to a forge/ branch first.',
          retryable: false
        });
      }
      const source = await repositoryPushSource(this.env, record.workspace, input.ref, commit);
      const result = await this.app.pushToRef(record, source, input.ref);
      if (!result.pushed) {
        throw new ForgeError({
          code: 'FORGE_GIT_PUSH_BLOCKED',
          message: `Could not stage the branch for review: ${result.reason ?? 'unknown error'}`,
          retryable: true
        });
      }
      // The commits are on GitHub now, which is exactly what hasUnpushedWork
      // tracks: "would tearing this down lose work?". Leaving it set made
      // forge_workspace_destroy refuse right after submitting — telling the agent
      // to push the branch, i.e. steering it back to the blocking path — and made
      // the idle reaper treat an already-safe workspace as dirty.
      record.workspace.hasUnpushedWork = false;
      await this.save(record);
      return { ref: input.ref, commit };
    });
  }

  // Best-effort, no-approval safety push to a Forge-owned backup ref — see
  // Application.backupUnpushedWork. Called by the idle reaper right before it
  // destroys a dirty workspace, never as part of any human-facing tool.
  async backupUnpushedWork(): Promise<{ pushed: boolean; ref?: string; reason?: string }> {
    const record = await this.getRecord();
    if (!record.workspace.hasUnpushedWork || !record.workspace.currentBranch || !record.workspace.currentCommit) {
      return { pushed: false, reason: 'nothing to back up' };
    }
    const backupRef = `forge/backup/${record.workspace.id}`;
    let source: { url: string; authorizationHeader: string };
    try {
      source = await repositoryPushSource(this.env, record.workspace, backupRef, record.workspace.currentCommit);
    } catch (error) {
      return { pushed: false, reason: error instanceof Error ? error.message.slice(0, 300) : 'no authorization' };
    }
    return this.app.backupUnpushedWork(record, source);
  }

  /**
   * Bring up the project's dev server and expose it, in one call.
   *
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
    const record = await this.getRecord();
    if (record.workspace.state !== 'ready') {
      return { ready: false, reason: `workspace is ${record.workspace.state}` };
    }
    const devCommand = record.detection?.devCommand;
    if (!devCommand) {
      return { ready: false, reason: 'no dev server command was detected for this project' };
    }
    const port = record.detection?.expectedPorts?.[0] ?? 3000;

    // Reuse a live preview rather than starting a second server.
    const live = Object.entries(record.previews).find(
      ([, preview]) => preview.port === port && Date.parse(preview.expiresAt) > Date.now()
    );
    if (live) {
      return { ready: true, previewId: live[0], port, expiresAt: live[1].expiresAt };
    }

    const existingProcess = Object.entries(record.processes).find(([, value]) => value.command === devCommand);
    let processId = existingProcess?.[0];
    if (!processId) {
      const started = await this.processStart({
        command: devCommand,
        cwd: '/workspace/repo',
        environment: {},
        networkPolicy: 'development',
        idempotencyKey: `review-preview-process-${record.workspace.id}`
      });
      if ('replay' in started && started.replay) {
        const refreshed = await this.getRecord();
        processId = Object.entries(refreshed.processes).find(([, value]) => value.command === devCommand)?.[0];
      } else {
        processId = (started as { value?: { processId?: string } }).value?.processId
          ?? Object.entries((await this.getRecord()).processes).find(([, value]) => value.command === devCommand)?.[0];
      }
    }
    if (!processId) return { ready: false, reason: 'the dev server did not start' };

    const exposed = await this.previewExpose({
      processId: processId as ProcessId,
      port,
      hostname: input.hostname,
      access: 'private',
      ttlSeconds: input.ttlSeconds,
      idempotencyKey: `review-preview-expose-${record.workspace.id}-${port}`
    });
    if ('replay' in exposed && exposed.replay) {
      const refreshed = await this.getRecord();
      const found = Object.entries(refreshed.previews).find(([, preview]) => preview.port === port);
      return found
        ? { ready: true, previewId: found[0], port, expiresAt: found[1].expiresAt }
        : { ready: false, reason: 'preview is still starting' };
    }
    const value = exposed as { previewId?: string; expiresAt?: string };
    return value.previewId && value.expiresAt
      ? { ready: true, previewId: value.previewId, port, expiresAt: value.expiresAt }
      : { ready: false, reason: 'preview is still starting' };
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
    force?: boolean;
  }) {
    return this.serializeMutation(async () => {
      const record = await this.getRecord();
      try {
        await this.app.reconcileGitState(record);
        if (!input.force) {
          await this.durablePushBeforeTeardown().catch(() => undefined);
          const source = await repositoryCloneSource(this.env, record.workspace);
          await this.app.assertDestroySafe(record, source);
        }
        return this.app.requestDestroy(
          record,
          input.expectedRevision,
          input.idempotencyKey,
          input.force
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
