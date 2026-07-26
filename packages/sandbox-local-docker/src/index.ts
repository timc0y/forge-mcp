import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { ids, type ProcessId } from '@forge/core';
import type {
  CreateSandboxInput,
  ExecInput,
  ExecResult,
  ExposePortInput,
  FileReadInput,
  FileReadResult,
  FileTree,
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

interface LocalSandboxRecord {
  root: string;
  containerName: string;
  image: string;
}

const sandboxes = new Map<string, LocalSandboxRecord>();
const snapshots = new Map<string, string>();

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(value)) {
    throw new Error('Invalid local Docker sandbox identifier.');
  }
  return value;
}

function workspaceRelative(input: string): string {
  if (input === '/workspace') return '';
  if (!input.startsWith('/workspace/')) throw new Error('Path must be inside /workspace.');
  const value = input.slice('/workspace/'.length);
  if (value.split('/').includes('..') || value.includes('\0')) throw new Error('Unsafe workspace path.');
  return value;
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await access(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error('No existing parent path.');
      current = parent;
    }
  }
}

async function pathIn(root: string, input: string, allowMissing = false): Promise<string> {
  const base = await realpath(root);
  const candidate = resolve(base, workspaceRelative(input));
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
    throw new Error('Path escaped the workspace root.');
  }
  const checked = allowMissing
    ? await realpath(await nearestExisting(candidate))
    : await realpath(candidate);
  if (checked !== base && !checked.startsWith(`${base}${sep}`)) {
    throw new Error('Symlink escaped the workspace root.');
  }
  return candidate;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

async function run(
  command: string,
  args: string[],
  options: {
    stdin?: string;
    timeoutMs?: number;
    outputLimitBytes?: number;
  } = {}
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const limit = options.outputLimitBytes ?? 200_000;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current: string, chunk: Buffer): string => {
      const currentBytes = Buffer.byteLength(current);
      if (currentBytes >= limit) {
        truncated = true;
        return current;
      }
      const available = limit - currentBytes;
      if (chunk.byteLength > available) truncated = true;
      return current + chunk.subarray(0, available).toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
      : undefined;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
        truncated
      });
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        exitCode: 1,
        stdout,
        stderr: error.message,
        truncated
      });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

class LocalDockerHandle implements SandboxHandle {
  constructor(
    readonly providerId: string,
    private readonly record: LocalSandboxRecord
  ) {}

  private dockerExecArgs(input: {
    cwd: string;
    environment?: Record<string, string>;
    interactive?: boolean;
  }): string[] {
    const args = ['exec'];
    if (input.interactive) args.push('-i');
    args.push('-w', input.cwd);
    for (const [key, value] of Object.entries(input.environment ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid environment variable name.');
      args.push('-e', `${key}=${value}`);
    }
    args.push(this.record.containerName);
    return args;
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    const started = Date.now();
    const cwd = `/workspace/${workspaceRelative(input.cwd)}`.replace(/\/$/, '') || '/workspace';
    const result = await run(
      'docker',
      [
        ...this.dockerExecArgs({
          cwd,
          environment: input.environment,
          interactive: input.stdin !== undefined
        }),
        '/bin/sh',
        '-lc',
        input.command
      ],
      {
        stdin: input.stdin,
        timeoutMs: input.timeoutMs,
        outputLimitBytes: input.outputLimitBytes
      }
    );
    return {
      ...result,
      durationMs: Date.now() - started,
      artifactRefs: []
    };
  }

  async startProcess(input: StartProcessInput): Promise<ProcessRecord> {
    const processDir = '/workspace/forge/processes';
    const log = `${processDir}/${input.processId}.log`;
    const pid = `${processDir}/${input.processId}.pid`;
    const command = `mkdir -p ${processDir}; setsid /bin/sh -lc ${JSON.stringify(input.command)} > ${log} 2>&1 < /dev/null & echo $! > ${pid}`;
    const result = await run('docker', [
      ...this.dockerExecArgs({
        cwd: input.cwd,
        environment: input.environment
      }),
      '/bin/sh',
      '-lc',
      command
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Failed to start process.');
    const detail = await this.getProcess(input.processId);
    if (!detail) throw new Error('Process did not start.');
    return detail;
  }

  async getProcess(id: ProcessId): Promise<ProcessRecord | null> {
    const pidFile = `/workspace/forge/processes/${id}.pid`;
    const result = await run('docker', [
      ...this.dockerExecArgs({ cwd: '/workspace' }),
      '/bin/sh',
      '-lc',
      `test -f ${pidFile} && pid=$(cat ${pidFile}) && if kill -0 "$pid" 2>/dev/null; then printf 'running:%s' "$pid"; else printf 'exited:%s' "$pid"; fi`
    ]);
    if (result.exitCode !== 0 || !result.stdout.includes(':')) return null;
    const [status, rawPid] = result.stdout.trim().split(':');
    return {
      id,
      providerProcessId: id,
      command: '',
      cwd: '/workspace/repo',
      status: status === 'running' ? 'running' : 'exited',
      pid: Number(rawPid)
    };
  }

  async readProcessLogs(input: ProcessLogsInput): Promise<ProcessLogsResult> {
    const path = `/workspace/forge/processes/${input.processId}.log`;
    const result = await run('docker', [
      ...this.dockerExecArgs({ cwd: '/workspace' }),
      '/bin/sh',
      '-lc',
      `test -f ${path} && cat ${path} || true`
    ], { outputLimitBytes: 2_000_000 });
    const start = Number.parseInt(input.cursor ?? '0', 10);
    const offset = Number.isFinite(start) && start >= 0 ? start : 0;
    const data = result.stdout.slice(offset, offset + input.limitBytes);
    const next = offset + data.length;
    return {
      data,
      nextCursor: next < result.stdout.length ? String(next) : undefined,
      truncated: next < result.stdout.length
    };
  }

  async stopProcess(id: ProcessId): Promise<void> {
    const pidFile = `/workspace/forge/processes/${id}.pid`;
    await run('docker', [
      ...this.dockerExecArgs({ cwd: '/workspace' }),
      '/bin/sh',
      '-lc',
      `test -f ${pidFile} && kill -TERM -- -$(cat ${pidFile}) 2>/dev/null || true`
    ]);
  }

  async readFile(input: FileReadInput): Promise<FileReadResult> {
    const path = await pathIn(this.record.root, input.path);
    const content = await readFile(path, 'utf8');
    const lines = content.split('\n');
    const selected =
      input.startLine !== undefined || input.endLine !== undefined
        ? lines
            .slice(Math.max(0, (input.startLine ?? 1) - 1), input.endLine)
            .join('\n')
        : content;
    const bytes = Buffer.from(selected);
    const limited = bytes.subarray(0, input.maxBytes).toString('utf8');
    return {
      path: input.path,
      content: limited,
      sha256: digest(content),
      sizeBytes: Buffer.byteLength(content),
      truncated: bytes.byteLength > input.maxBytes
    };
  }

  async writeFile(input: FileWriteInput): Promise<FileWriteResult> {
    const path = await pathIn(this.record.root, input.path, true);
    await mkdir(dirname(path), { recursive: true });
    if (input.expectedSha256) {
      const current = await readFile(path, 'utf8');
      if (digest(current) !== input.expectedSha256) {
        throw new Error('FILE_HASH_CONFLICT');
      }
    }
    await writeFile(path, input.content);
    return {
      path: input.path,
      sha256: digest(input.content),
      sizeBytes: Buffer.byteLength(input.content)
    };
  }

  async applyPatch(input: PatchInput): Promise<PatchResult> {
    const result = await this.exec({
      command: 'git apply --whitespace=nowarn -',
      cwd: input.cwd,
      timeoutMs: 60_000,
      stdin: input.patch,
      outputLimitBytes: 100_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    const changed = await this.exec({
      command: 'git diff --name-only',
      cwd: input.cwd,
      timeoutMs: 30_000,
      outputLimitBytes: 100_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    return {
      applied: result.exitCode === 0,
      output: result.stderr || result.stdout,
      changedFiles: changed.stdout.split('\n').filter(Boolean)
    };
  }

  async listFiles(input: ListFilesInput): Promise<FileTree> {
    const command = `find . -maxdepth ${Math.max(1, input.depth)} -printf '%y\\t%s\\t%p\\n' | head -n ${input.limit + 1}`;
    const result = await this.exec({
      command,
      cwd: input.path,
      timeoutMs: 30_000,
      outputLimitBytes: 1_000_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    const rows = result.stdout.split('\n').filter(Boolean);
    const entries = rows.slice(0, input.limit).map((row) => {
      const [kind = 'f', size = '0', path = '.'] = row.split('\t');
      return {
        path: `${input.path}/${path.replace(/^\.\/?/, '')}`.replace(/\/$/, ''),
        type: kind === 'd' ? ('directory' as const) : kind === 'l' ? ('symlink' as const) : ('file' as const),
        sizeBytes: kind === 'f' ? Number(size) : undefined
      };
    });
    return { entries, truncated: rows.length > input.limit };
  }

  async exposePort(input: ExposePortInput): Promise<PreviewEndpoint> {
    const result = await run('docker', [
      'inspect',
      '-f',
      '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      this.record.containerName
    ]);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error('Could not resolve local Docker container address.');
    }
    return {
      port: input.port,
      providerUrl: `http://${result.stdout.trim()}:${input.port}`,
      name: input.name
    };
  }

  async revokePort(_port: number): Promise<void> {}
}

export class LocalDockerSandboxProvider implements SandboxProvider {
  readonly kind = 'local-docker' as const;
  readonly version = '0.2.0';

  constructor(
    private readonly imageOverride = process.env.FORGE_LOCAL_DOCKER_IMAGE
  ) {}

  private imageFor(runtimeProfile: CreateSandboxInput['runtimeProfile']): string {
    if (this.imageOverride) return this.imageOverride;
    if (runtimeProfile === 'node-24') return 'node:24-bookworm-slim';
    if (runtimeProfile === 'node-22') return 'node:22-bookworm-slim';
    if (runtimeProfile === 'python-3.13') return 'python:3.13-slim';
    return 'node:22-bookworm-slim';
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const providerId = safeName(input.providerId);
    const root = join(tmpdir(), `forge-${providerId}`);
    const containerName = `forge-${providerId}`;
    await mkdir(join(root, 'repo'), { recursive: true });
    await mkdir(join(root, 'forge', 'processes'), { recursive: true });
    await run('docker', ['rm', '-f', containerName]);
    const image = this.imageFor(input.runtimeProfile);
    const result = await run('docker', [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      `forge.workspace=${providerId}`,
      '--network',
      'bridge',
      '-v',
      `${root}:/workspace`,
      '-w',
      '/workspace',
      image,
      '/bin/sh',
      '-lc',
      'sleep infinity'
    ], { timeoutMs: 120_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'Docker sandbox failed to start.');
    const record = { root, containerName, image };
    sandboxes.set(providerId, record);
    return new LocalDockerHandle(providerId, record);
  }

  async get(providerId: string): Promise<SandboxHandle> {
    const record = sandboxes.get(providerId);
    if (!record) throw new Error('Local Docker sandbox was not found.');
    return new LocalDockerHandle(providerId, record);
  }

  async suspend(providerId: string): Promise<void> {
    const record = sandboxes.get(providerId);
    if (record) await run('docker', ['pause', record.containerName]);
  }

  async resume(providerId: string): Promise<SandboxHandle> {
    const record = sandboxes.get(providerId);
    if (!record) throw new Error('Local Docker sandbox was not found.');
    await run('docker', ['unpause', record.containerName]);
    return new LocalDockerHandle(providerId, record);
  }

  async destroy(providerId: string): Promise<void> {
    const record = sandboxes.get(providerId);
    if (!record) return;
    await run('docker', ['rm', '-f', record.containerName]);
    await rm(record.root, { recursive: true, force: true });
    sandboxes.delete(providerId);
  }

  async snapshot(providerId: string, _input: SnapshotInput): Promise<SnapshotRef> {
    const record = sandboxes.get(providerId);
    if (!record) throw new Error('Local Docker sandbox was not found.');
    const id = ids.snapshot();
    const destination = join(tmpdir(), `forge-snapshot-${id}`);
    await cp(record.root, destination, { recursive: true });
    snapshots.set(id, destination);
    return {
      id,
      providerSnapshotId: destination,
      providerVersion: this.version,
      createdAt: new Date().toISOString()
    };
  }

  async restore(
    snapshot: SnapshotRef,
    input: CreateSandboxInput
  ): Promise<SandboxHandle> {
    const source = snapshots.get(snapshot.id) ?? snapshot.providerSnapshotId;
    const handle = await this.create(input);
    const record = sandboxes.get(input.providerId);
    if (!record) throw new Error('Local Docker sandbox was not created.');
    await cp(source, record.root, { recursive: true, force: true });
    return handle;
  }
}

export async function localDockerAvailable(): Promise<boolean> {
  const host = process.env.DOCKER_HOST;
  if (host && !host.startsWith('unix://')) return true;
  const socket = host?.slice('unix://'.length) || '/var/run/docker.sock';
  try {
    await access(socket);
    return true;
  } catch {
    return false;
  }
}
