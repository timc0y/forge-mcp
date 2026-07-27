import type { ArtifactId, ProcessId, SnapshotId } from '@forge/core';

export type RuntimeProfile = 'node-22' | 'node-24' | 'python-3.13' | 'general-purpose';
export type NetworkPolicyMode = 'deny_all' | 'package_install' | 'development' | 'custom_allowlist' | 'unrestricted_with_approval';

export interface CreateSandboxInput {
  providerId: string;
  runtimeProfile: RuntimeProfile;
  labels: Record<string, string>;
  idleTimeout: string;
  /** When true, prevent automatic container sleep (Cloudflare keepAlive). */
  keepAlive?: boolean;
}

export interface ExecInput {
  command: string;
  cwd: string;
  timeoutMs: number;
  environment?: Record<string, string>;
  stdin?: string;
  outputLimitBytes: number;
  sessionId: string;
  networkPolicy: NetworkPolicyMode;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  artifactRefs: ArtifactId[];
}

export interface StartProcessInput extends Omit<ExecInput, 'timeoutMs' | 'outputLimitBytes'> {
  processId: ProcessId;
  autoCleanup: boolean;
  /** Whether Forge classified this command as mutating the filesystem. */
  mutatesFilesystem?: boolean;
}

export type ProcessStatus = 'starting' | 'running' | 'exited' | 'failed' | 'stopped' | 'cancelled' | 'orphaned';

export interface ProcessRecord {
  id: ProcessId;
  providerProcessId: string;
  command: string;
  cwd: string;
  status: ProcessStatus;
  pid?: number;
  /** Exit code when the process has terminated. Undefined while still running. */
  exitCode?: number;
  /** ISO timestamp when the process was started. */
  startedAt: string;
  /** ISO timestamp when the process reached a terminal state. Undefined while running. */
  completedAt?: string;
  /** Whether the command is classified as mutating the filesystem (read_only vs local_mutation/dependency_install/etc). */
  mutatesFilesystem: boolean;
  /** Snapshot id of the checkpoint captured after a successful mutating process exited. */
  checkpointAfter?: SnapshotId;
  /** Artifact id of the persisted log output for this process. */
  logArtifact?: ArtifactId;
}

export interface ProcessLogsInput { processId: ProcessId; cursor?: string; limitBytes: number; }
export interface ProcessLogsResult {
  data: string;
  /** Opaque cursor for the next page. Absent/undefined when no more log bytes remain. */
  nextCursor?: string;
  truncated: boolean;
}
export interface FileReadInput { path: string; startLine?: number; endLine?: number; maxBytes: number; }
export interface FileReadResult { path: string; content: string; sha256: string; sizeBytes: number; truncated: boolean; }
export interface FileWriteInput { path: string; content: string; expectedSha256?: string; }
export interface FileWriteResult { path: string; sha256: string; sizeBytes: number; }
export interface PatchInput { patch: string; cwd: string; paths?: string[]; }
export interface PatchResult { applied: boolean; output: string; changedFiles: string[]; rejectedFiles?: string[]; rolledBack?: boolean; }
export interface ListFilesInput { path: string; depth: number; include?: string[]; exclude?: string[]; limit: number; }
export interface FileTreeEntry { path: string; type: 'file' | 'directory' | 'symlink'; sizeBytes?: number; }
export interface FileTree { entries: FileTreeEntry[]; truncated: boolean; }
export interface ExposePortInput { port: number; name: string; hostname: string; token: string; }
export interface PreviewEndpoint { port: number; providerUrl: string; name: string; }
export interface SnapshotInput { name?: string; ttlSeconds: number; excludeGitignored: boolean; }
export interface SnapshotRef { id: SnapshotId; providerSnapshotId: string; providerVersion: string; createdAt: string; }
