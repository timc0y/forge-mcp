import type { ProcessId } from '@forge/core';
import type {
  CreateSandboxInput, ExecInput, ExecResult, ExposePortInput, FileReadInput, FileReadResult,
  FileTree, FileWriteInput, FileWriteResult, ListFilesInput, PatchInput, PatchResult,
  PreviewEndpoint, ProcessLogsInput, ProcessLogsResult, ProcessRecord, SnapshotInput,
  SnapshotRef, StartProcessInput
} from './types';

export interface SandboxHealth {
  healthy: boolean;
  kind: SandboxProvider['kind'];
  // Human-readable checks that ran (tools present, disk free, self-test passed…).
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  // Optional concurrency signal. When present and inUse >= max the backend is at
  // capacity, so Forge routes the new workspace elsewhere rather than overload it.
  capacity?: { max: number; inUse: number };
  detail?: string;
}

export interface SandboxProvider {
  readonly kind: 'cloudflare' | 'local-docker' | 'self-hosted';
  readonly version: string;
  // Optional readiness probe. A provider that can be unavailable or flaky
  // (e.g. a self-hosted box) implements this so Forge can health-check it before
  // routing work to it and fall back otherwise. Cloudflare omits it (always on).
  healthCheck?(): Promise<SandboxHealth>;
  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  get(providerId: string): Promise<SandboxHandle>;
  /**
   * Prevent or allow automatic container sleep. Required while managed mutating
   * processes run: a sleep wipes the live filesystem and discards their writes.
   */
  setKeepAlive?(providerId: string, keepAlive: boolean): Promise<void>;
  suspend(providerId: string): Promise<void>;
  resume(providerId: string): Promise<SandboxHandle>;
  destroy(providerId: string): Promise<void>;
  snapshot(providerId: string, input: SnapshotInput): Promise<SnapshotRef>;
  restore(snapshot: SnapshotRef, input: CreateSandboxInput): Promise<SandboxHandle>;
}

export interface SandboxHandle {
  readonly providerId: string;
  exec(input: ExecInput): Promise<ExecResult>;
  startProcess(input: StartProcessInput): Promise<ProcessRecord>;
  getProcess(processId: ProcessId): Promise<ProcessRecord | null>;
  readProcessLogs(input: ProcessLogsInput): Promise<ProcessLogsResult>;
  stopProcess(processId: ProcessId): Promise<void>;
  /**
   * Wait for a managed process to reach a terminal state, or reject on timeout.
   * Returns the final ProcessRecord. Does not throw if the process already exited.
   */
  processWait?(input: { processId: ProcessId; timeoutMs?: number }): Promise<ProcessRecord>;
  /**
   * Cancel (SIGTERM then SIGKILL) a managed process. Returns the final
   * ProcessRecord with status 'cancelled'. No-op if the process already exited.
   */
  processCancel?(processId: ProcessId): Promise<ProcessRecord>;
  readFile(input: FileReadInput): Promise<FileReadResult>;
  writeFile(input: FileWriteInput): Promise<FileWriteResult>;
  applyPatch(input: PatchInput): Promise<PatchResult>;
  listFiles(input: ListFilesInput): Promise<FileTree>;
  exposePort(input: ExposePortInput): Promise<PreviewEndpoint>;
  revokePort(port: number): Promise<void>;
}
