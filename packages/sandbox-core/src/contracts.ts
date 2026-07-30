import type { ProcessId } from '@forge/core';
import type {
  CreateSandboxInput, ExecInput, ExecResult, ExposePortInput, FileReadInput, FileReadResult,
  FileTree, FileWriteInput, FileWriteResult, ListFilesInput,
  PreviewEndpoint, ProcessLogsInput, ProcessLogsResult, ProcessRecord, StartProcessInput
} from './types';

export interface SandboxProvider {
  readonly kind: 'cloudflare';
  readonly version: string;
  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  get(providerId: string): Promise<SandboxHandle>;
  /**
   * Prevent or allow automatic container sleep. Required while managed mutating
   * processes run: a sleep wipes the live filesystem and discards their writes.
   */
  setKeepAlive?(providerId: string, keepAlive: boolean): Promise<void>;
  destroy(providerId: string): Promise<void>;
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
  listFiles(input: ListFilesInput): Promise<FileTree>;
  exposePort(input: ExposePortInput): Promise<PreviewEndpoint>;
  revokePort(port: number): Promise<void>;
}
