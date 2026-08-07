import type { ArtifactId, ProcessId } from '@forge/core';

export type RuntimeProfile = 'node-22' | 'node-24' | 'python-3.13' | 'general-purpose';
export type NetworkPolicyMode = 'deny_all' | 'package_install' | 'development' | 'custom_allowlist' | 'unrestricted_with_approval';

export interface CreateSandboxInput {
  providerId: string;
  runtimeProfile: RuntimeProfile;
  labels: Record<string, string>;
  idleTimeout: string;
  /** Prevents automatic container sleep. */
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
  /** Command mutates filesystem. */
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
  /** Exit code. Undefined while running. */
  exitCode?: number;
  /** Started ISO timestamp. */
  startedAt: string;
  /** Completed ISO timestamp. Undefined while running. */
  completedAt?: string;
  /** Command mutates filesystem. */
  mutatesFilesystem: boolean;
  /** Log output artifact ID. */
  logArtifact?: ArtifactId;
}

export interface ProcessLogsInput { processId: ProcessId; cursor?: string; limitBytes: number; }
export interface ProcessLogsResult {
  data: string;
  /** Next page cursor. */
  nextCursor?: string;
  truncated: boolean;
}
export interface FileReadInput { path: string; startLine?: number; endLine?: number; maxBytes: number; }
export interface FileReadResult { path: string; content: string; sha256: string; sizeBytes: number; truncated: boolean; }
export interface FileWriteInput { path: string; content: string; expectedSha256?: string; }
export interface FileWriteResult { path: string; sha256: string; sizeBytes: number; }
export interface ListFilesInput { path: string; depth: number; include?: string[]; exclude?: string[]; limit: number; }
export interface FileTreeEntry { path: string; type: 'file' | 'directory' | 'symlink'; sizeBytes?: number; }
export interface FileTree { entries: FileTreeEntry[]; truncated: boolean; }
export interface ExposePortInput { port: number; name: string; hostname: string; token: string; }
export interface PreviewEndpoint { port: number; providerUrl: string; name: string; }
