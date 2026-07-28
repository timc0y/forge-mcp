import { getSandbox, type ExecutionSession, type Sandbox } from '@cloudflare/sandbox';
import { ForgeError, ids, type ProcessId } from '@forge/core';
import type {
  CreateSandboxInput,
  ExecInput,
  ExecResult,
  ExposePortInput,
  FileReadInput,
  FileReadResult,
  FileTree,
  FileTreeEntry,
  FileWriteInput,
  FileWriteResult,
  ListFilesInput,
  PatchInput,
  PatchResult,
  PreviewEndpoint,
  ProcessLogsInput,
  ProcessLogsResult,
  ProcessRecord,
  SandboxHandle,
  SandboxProvider,
  SnapshotInput,
  SnapshotRef,
  StartProcessInput
} from '@forge/sandbox-core';
import { mapCloudflareSandboxError } from './error-map';

export interface CloudflareSandboxEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
}

const ROOT = '/workspace';
const REPO_ROOT = '/workspace/repo';
const REPO = '/workspace/repo';
const TRANSPORT = 'rpc' as const;

function assertWorkspacePath(path: string): string {
  if (!path.startsWith(`${ROOT}/`) && path !== ROOT) {
    throw new Error('Path must remain inside /workspace.');
  }
  if (path.includes('\0') || path.split('/').includes('..')) {
    throw new Error('Unsafe workspace path.');
  }
  return path.replace(/\/+$/, '') || ROOT;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// git apply emits `error: patch failed: path/to/file:12` and
// `error: path/to/file: patch does not apply` on rejection. Surface the
// offending paths so the caller learns which file blocked the patch.
function parseRejectedPatchFiles(output: string): string[] {
  const files = new Set<string>();
  for (const line of output.split('\n')) {
    const failed = line.match(/patch failed:\s*(.+?):\d+/);
    if (failed?.[1]) {
      files.add(failed[1].trim());
      continue;
    }
    const doesNotApply = line.match(/error:\s*(.+?):\s*patch does not apply/);
    if (doesNotApply?.[1]) files.add(doesNotApply[1].trim());
  }
  return [...files];
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function truncate(value: string, limit: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= limit) return { value, truncated: false };
  return { value: new TextDecoder().decode(bytes.slice(0, limit)), truncated: true };
}

function mapProcessStatus(status: string): ProcessRecord['status'] {
  switch (status) {
    case 'starting': return 'starting';
    case 'running': return 'running';
    case 'failed':
    case 'error': return 'failed';
    case 'killed': return 'stopped';
    default: return 'exited';
  }
}

class CloudflareSandboxHandle implements SandboxHandle {
  private readonly processMutatesFilesystem = new Map<string, boolean>();

  constructor(readonly providerId: string, private readonly sandbox: Sandbox) {}

  private async session(id: string, cwd = ROOT): Promise<ExecutionSession> {
    try {
      return await this.sandbox.getSession(id);
    } catch {
      return this.sandbox.createSession({ id, cwd, commandTimeoutMs: 300_000 });
    }
  }

  private async canonicalWorkspacePath(path: string): Promise<string> {
    const lexical = assertWorkspacePath(path);
    // The workspace root and the repo checkout are both created by Forge itself
    // (mkdir + git clone), so neither can be a hostile symlink escaping /workspace.
    // Skip the realpath exec — a container round trip that can also wake a sleeping
    // sandbox — for these two constants, which cover nearly every tool call and
    // provisioning step. Arbitrary caller paths still get the check below.
    if (lexical === ROOT || lexical === REPO_ROOT) return lexical;
    const session = await this.session('system', ROOT);
    const result = await session.exec(`realpath -m -- ${shellQuote(lexical)}`, {
      cwd: ROOT,
      timeout: 10_000
    });
    const canonical = result.stdout.trim().replace(/\/+$/, '') || ROOT;
    if (
      result.exitCode !== 0 ||
      (canonical !== ROOT && !canonical.startsWith(`${ROOT}/`))
    ) {
      throw new Error('Workspace path resolves outside /workspace.');
    }
    return lexical;
  }

  // `cwd` is already canonicalized by the caller; do not resolve it again (that
  // was a second container round trip per stdin exec).
  private async commandWithStdin(input: ExecInput, session: ExecutionSession, cwd: string) {
    if (input.stdin === undefined) {
      return session.exec(input.command, {
        cwd,
        timeout: input.timeoutMs,
        env: input.environment
      });
    }
    const path = `/workspace/tmp/stdin-${crypto.randomUUID()}`;
    await this.sandbox.writeFile(path, input.stdin, { sessionId: input.sessionId });
    try {
      return await session.exec(`${input.command} < ${shellQuote(path)}`, {
        cwd,
        timeout: input.timeoutMs,
        env: input.environment
      });
    } finally {
      await this.sandbox.deleteFile(path).catch(() => undefined);
    }
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    const started = Date.now();
    try {
      const cwd = await this.canonicalWorkspacePath(input.cwd);
      const session = await this.session(input.sessionId, cwd);
      const result = await this.commandWithStdin(input, session, cwd);
      const stdout = truncate(result.stdout, input.outputLimitBytes);
      const stdoutBytes = new TextEncoder().encode(stdout.value).byteLength;
      const stderr = truncate(result.stderr, Math.max(0, input.outputLimitBytes - stdoutBytes));
      return {
        exitCode: result.exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
        artifactRefs: []
      };
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'exec');
    }
  }

  async startProcess(input: StartProcessInput): Promise<ProcessRecord> {
    try {
      if (input.stdin !== undefined) throw new Error('Background-process stdin is not supported.');
      const cwd = await this.canonicalWorkspacePath(input.cwd);
      const session = await this.session(input.sessionId, cwd);
      const process = await session.startProcess(input.command, {
        cwd,
        env: input.environment,
        processId: input.processId,
        autoCleanup: input.autoCleanup
      });
      const mutatesFilesystem = input.mutatesFilesystem ?? false;
      this.processMutatesFilesystem.set(input.processId, mutatesFilesystem);
      return {
        id: input.processId,
        providerProcessId: process.id,
        command: process.command,
        cwd: input.cwd,
        status: mapProcessStatus(process.status),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        mutatesFilesystem
      };
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'startProcess');
    }
  }

  async getProcess(processId: ProcessId): Promise<ProcessRecord | null> {
    try {
      const process = await this.sandbox.getProcess(processId);
      if (!process) return null;
      const status = mapProcessStatus(process.status);
      const isTerminal = status === 'exited' || status === 'failed' || status === 'stopped';
      return {
        id: processId,
        providerProcessId: process.id,
        command: process.command,
        cwd: REPO,
        status,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        mutatesFilesystem: this.processMutatesFilesystem.get(processId) ?? false,
        ...(isTerminal ? { completedAt: new Date().toISOString(), exitCode: process.exitCode ?? 0 } : {})
      };
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'getProcess');
    }
  }

  async readProcessLogs(input: ProcessLogsInput): Promise<ProcessLogsResult> {
    try {
      const process = await this.sandbox.getProcess(input.processId);
      if (!process) throw new Error('PROCESS_NOT_FOUND');
      const logs = await process.getLogs();
      const raw = `${logs.stdout}${logs.stderr}`;
      const start = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      const offset = Number.isFinite(start) && start >= 0 ? start : 0;
      const chunk = truncate(raw.slice(offset), input.limitBytes);
      const next = offset + chunk.value.length;
      return {
        data: chunk.value,
        nextCursor: next < raw.length ? String(next) : undefined,
        truncated: chunk.truncated || next < raw.length
      };
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'readProcessLogs');
    }
  }

  async stopProcess(processId: ProcessId): Promise<void> {
    try {
      const process = await this.sandbox.getProcess(processId);
      if (process) await process.kill('SIGTERM');
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'stopProcess');
    }
  }

  async processWait(input: { processId: ProcessId; timeoutMs?: number }): Promise<ProcessRecord> {
    try {
      const timeoutMs = input.timeoutMs ?? 120_000;
      const deadline = Date.now() + timeoutMs;
      let consecutiveMisses = 0;
      let lastSeen: { id: string; command: string; pid?: number } | null = null;
      for (;;) {
        // Re-fetch each poll. A stale Process object can keep reporting
        // `running` forever, which previously made wait SIGKILL healthy work.
        let process: Awaited<ReturnType<Sandbox['getProcess']>> | null = null;
        try {
          process = await this.sandbox.getProcess(input.processId);
        } catch {
          process = null;
        }
        if (!process) {
          consecutiveMisses += 1;
          // Transient provider blips can briefly return null for a live process.
          // Only declare failure after repeated confirmed misses.
          if (consecutiveMisses >= 5 && Date.now() >= deadline) {
            return {
              id: input.processId,
              providerProcessId: lastSeen?.id ?? input.processId,
              command: lastSeen?.command ?? '',
              cwd: REPO,
              status: 'failed',
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              exitCode: 1,
              mutatesFilesystem: this.processMutatesFilesystem.get(input.processId) ?? false
            };
          }
          if (Date.now() >= deadline) {
            throw new ForgeError({
              code: 'FORGE_COMMAND_TIMEOUT',
              message: `Timed out waiting for process ${input.processId} after ${timeoutMs}ms; process lookup was intermittently unavailable.`,
              retryable: true,
              details: { processId: input.processId, status: 'unknown', timeoutMs, consecutiveMisses }
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        consecutiveMisses = 0;
        lastSeen = { id: process.id, command: process.command, pid: process.pid };
        const status = mapProcessStatus(process.status);
        if (status !== 'running' && status !== 'starting') {
          return {
            id: input.processId,
            providerProcessId: process.id,
            command: process.command,
            cwd: REPO,
            status,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            exitCode: process.exitCode ?? 0,
            mutatesFilesystem: this.processMutatesFilesystem.get(input.processId) ?? false
          };
        }
        if (Date.now() >= deadline) {
          // Observational timeout only — never kill. Cancellation is explicit
          // via processCancel. Killing here tore down long installs whose wait
          // budget was shorter than the install itself.
          throw new ForgeError({
            code: 'FORGE_COMMAND_TIMEOUT',
            message: `Timed out waiting for process ${input.processId} after ${timeoutMs}ms; the process is still running.`,
            retryable: true,
            details: {
              processId: input.processId,
              providerProcessId: process.id,
              status: 'running',
              pid: process.pid ?? null,
              timeoutMs
            }
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      throw mapCloudflareSandboxError(error, 'processWait');
    }
  }

  async processCancel(processId: ProcessId): Promise<ProcessRecord> {
    try {
      const process = await this.sandbox.getProcess(processId);
      if (process) {
        await process.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 500));
        try { await process.kill('SIGKILL'); } catch {}
      }
      return {
        id: processId,
        providerProcessId: process?.id ?? processId,
        command: process?.command ?? '',
        cwd: REPO,
        status: 'cancelled',
        pid: process?.pid,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        exitCode: 124,
        mutatesFilesystem: this.processMutatesFilesystem.get(processId) ?? false
      };
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'processCancel');
    }
  }

  async readFile(input: FileReadInput): Promise<FileReadResult> {
    const path = await this.canonicalWorkspacePath(input.path);
    try {
      const file = await this.sandbox.readFile(path, { sessionId: 'system' });
      const lines = file.content.split('\n');
      const selected = input.startLine !== undefined || input.endLine !== undefined
        ? lines.slice(Math.max(0, (input.startLine ?? 1) - 1), input.endLine).join('\n')
        : file.content;
      const limited = truncate(selected, input.maxBytes);
      return {
        path,
        content: limited.value,
        sha256: await sha256(file.content),
        sizeBytes: file.size ?? new TextEncoder().encode(file.content).byteLength,
        truncated: limited.truncated
      };
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'readFile');
    }
  }

  async writeFile(input: FileWriteInput): Promise<FileWriteResult> {
    const path = await this.canonicalWorkspacePath(input.path);
    try {
      if (input.expectedSha256) {
        const current = await this.readFile({ path, maxBytes: Number.MAX_SAFE_INTEGER });
        if (current.sha256 !== input.expectedSha256) throw new Error('FILE_HASH_CONFLICT');
      }
      // Create the parent directory so a headless agent can write a brand-new
      // file (e.g. a new module) without a separate mkdir step.
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent && parent !== ROOT) {
        const session = await this.session('system', ROOT);
        await session.exec(`mkdir -p ${shellQuote(parent)}`, { cwd: ROOT, timeout: 10_000 });
      }
      await this.sandbox.writeFile(path, input.content, { sessionId: 'system' });
      return {
        path,
        sha256: await sha256(input.content),
        sizeBytes: new TextEncoder().encode(input.content).byteLength
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'FILE_HASH_CONFLICT') throw error;
      throw mapCloudflareSandboxError(error, 'writeFile');
    }
  }

  async applyPatch(input: PatchInput): Promise<PatchResult> {
    const cwd = await this.canonicalWorkspacePath(input.cwd);
    const patchPath = `/workspace/tmp/patch-${crypto.randomUUID()}.diff`;
    try {
      await this.sandbox.writeFile(patchPath, input.patch, { sessionId: 'system' });
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'applyPatch:write');
    }
    try {
      // --check first so a rejected patch never mutates the tree; git apply is
      // atomic, so a failed check guarantees the working tree is unchanged.
      const check = await this.exec({
        command: `git apply --check --whitespace=nowarn ${shellQuote(patchPath)}`,
        cwd,
        timeoutMs: 60_000,
        outputLimitBytes: 100_000,
        sessionId: 'system',
        networkPolicy: 'deny_all'
      });
      if (check.exitCode !== 0) {
        const output = `${check.stdout}${check.stderr}`;
        return {
          applied: false,
          output,
          changedFiles: [],
          rejectedFiles: parseRejectedPatchFiles(output),
          rolledBack: true
        };
      }
      const result = await this.exec({
        command: `git apply --whitespace=nowarn ${shellQuote(patchPath)}`,
        cwd,
        timeoutMs: 60_000,
        outputLimitBytes: 100_000,
        sessionId: 'system',
        networkPolicy: 'deny_all'
      });
      if (result.exitCode !== 0) {
        const output = `${result.stdout}${result.stderr}`;
        return {
          applied: false,
          output,
          changedFiles: [],
          rejectedFiles: parseRejectedPatchFiles(output),
          rolledBack: true
        };
      }
      const changed = await this.exec({
        command: 'git diff --name-only',
        cwd,
        timeoutMs: 30_000,
        outputLimitBytes: 100_000,
        sessionId: 'system',
        networkPolicy: 'deny_all'
      });
      return {
        applied: true,
        output: `${result.stdout}${result.stderr}`,
        changedFiles: changed.stdout.split('\n').filter(Boolean)
      };
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'applyPatch');
    } finally {
      await this.sandbox.deleteFile(patchPath).catch(() => undefined);
    }
  }

  async listFiles(input: ListFilesInput): Promise<FileTree> {
    const root = await this.canonicalWorkspacePath(input.path);
    try {
      const result = await this.sandbox.listFiles(root, {
        recursive: true,
        includeHidden: true,
        sessionId: 'system'
      });
      const rootDepth = root.split('/').filter(Boolean).length;
      const entries: FileTreeEntry[] = result.files
        .filter((file) => file.absolutePath.split('/').filter(Boolean).length - rootDepth <= input.depth)
        .slice(0, input.limit)
        .map((file) => ({
          path: file.absolutePath,
          type: file.type === 'directory' ? 'directory' : file.type === 'symlink' ? 'symlink' : 'file',
          sizeBytes: file.type === 'file' ? file.size : undefined
        }));
      return { entries, truncated: result.files.length > entries.length };
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'listFiles');
    }
  }

  async exposePort(input: ExposePortInput): Promise<PreviewEndpoint> {
    return { port: input.port, providerUrl: 'forge-sandbox://internal', name: input.name };
  }

  async revokePort(_port: number): Promise<void> {}
}

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly kind = 'cloudflare' as const;
  readonly version = '0.12.4';

  constructor(private readonly env: CloudflareSandboxEnv) {}

  private sandbox(
    providerId: string,
    options?: Pick<CreateSandboxInput, 'idleTimeout' | 'labels' | 'keepAlive'>
  ): Sandbox {
    return getSandbox(this.env.Sandbox, providerId, {
      enableDefaultSession: false,
      normalizeId: true,
      // 10m matches the Sandbox SDK default. The previous 90s idle timeout let
      // containers sleep (and wipe /workspace) between a finished install and the
      // next shell command, which looked like "background writes do not persist".
      sleepAfter: options?.idleTimeout ?? '10m',
      keepAlive: options?.keepAlive ?? false,
      transport: TRANSPORT
    });
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const handle = new CloudflareSandboxHandle(
      input.providerId,
      this.sandbox(input.providerId, input)
    );
    await handle.exec({
      command: 'mkdir -p /workspace/repo /workspace/cache /workspace/artifacts /workspace/tmp /workspace/forge',
      cwd: ROOT,
      timeoutMs: 30_000,
      outputLimitBytes: 10_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    return handle;
  }

  async get(providerId: string): Promise<SandboxHandle> {
    return new CloudflareSandboxHandle(providerId, this.sandbox(providerId));
  }

  async setKeepAlive(providerId: string, keepAlive: boolean): Promise<void> {
    try {
      await this.sandbox(providerId).setKeepAlive(keepAlive);
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'setKeepAlive');
    }
  }

  async destroy(providerId: string): Promise<void> {
    try {
      await this.sandbox(providerId).destroy();
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'destroy');
    }
  }

  async snapshot(providerId: string, input: SnapshotInput): Promise<SnapshotRef> {
    try {
      const backup = await this.sandbox(providerId).createBackup({
        dir: ROOT,
        name: input.name,
        ttl: input.ttlSeconds,
        gitignore: input.excludeGitignored
      });
      return {
        id: ids.snapshot(),
        providerSnapshotId: JSON.stringify(backup),
        providerVersion: this.version,
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'snapshot');
    }
  }

  async restore(snapshot: SnapshotRef, input: CreateSandboxInput): Promise<SandboxHandle> {
    try {
      const handle = await this.create(input);
      const backup = JSON.parse(snapshot.providerSnapshotId) as Parameters<Sandbox['restoreBackup']>[0];
      await this.sandbox(input.providerId).restoreBackup(backup);
      return handle;
    } catch (error) {
      throw mapCloudflareSandboxError(error, 'restore');
    }
  }
}
