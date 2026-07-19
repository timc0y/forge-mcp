import { ForgeError, type ProcessId } from '@forge/core';
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
  SandboxHealth,
  SandboxProvider,
  SnapshotInput,
  SnapshotRef,
  StartProcessInput
} from '@forge/sandbox-core';

// The self-hosted provider talks to a "Forge Node Agent" — a small daemon the
// user runs on their own machine (e.g. a Mac mini), reachable over HTTPS through
// a tunnel. The agent runs each workspace in an isolated local container and
// exposes this JSON contract; the reference implementation lives in
// self-host/forge-node-agent. Forge health-checks the agent and only routes work
// to it when it is up and its self-test passes, otherwise it falls back to
// Cloudflare — the MCP caller sees no difference either way.

export interface SelfHostedConfig {
  baseUrl: string;
  token: string;
  // Injected for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
  // Per-request timeout; the agent is remote and may be flaky.
  timeoutMs?: number;
}

async function request<T>(config: SelfHostedConfig, path: string, body: unknown): Promise<T> {
  const doFetch = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 120_000);
  let response: Response;
  try {
    response = await doFetch(`${config.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal
    });
  } catch (error) {
    throw new ForgeError({
      code: 'FORGE_PROVIDER_UNAVAILABLE',
      message: `Self-hosted agent request to ${path} failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown'}.`,
      retryable: true
    });
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      // keep raw text
    }
    throw new ForgeError({
      code: response.status === 404 ? 'FORGE_WORKSPACE_NOT_FOUND' : 'FORGE_PROVIDER_UNAVAILABLE',
      message: `Self-hosted agent ${path} returned HTTP ${response.status}: ${detail}`,
      retryable: response.status >= 500
    });
  }
  return (text ? JSON.parse(text) : {}) as T;
}

class SelfHostedSandboxHandle implements SandboxHandle {
  constructor(
    private readonly config: SelfHostedConfig,
    readonly providerId: string
  ) {}

  private call<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    return request<T>(this.config, `/v1/sandboxes/${encodeURIComponent(this.providerId)}/${action}`, payload);
  }

  exec(input: ExecInput): Promise<ExecResult> {
    return this.call('exec', { input });
  }
  startProcess(input: StartProcessInput): Promise<ProcessRecord> {
    return this.call('process/start', { input });
  }
  getProcess(processId: ProcessId): Promise<ProcessRecord | null> {
    return this.call('process/get', { processId });
  }
  readProcessLogs(input: ProcessLogsInput): Promise<ProcessLogsResult> {
    return this.call('process/logs', { input });
  }
  stopProcess(processId: ProcessId): Promise<void> {
    return this.call('process/stop', { processId });
  }
  readFile(input: FileReadInput): Promise<FileReadResult> {
    return this.call('files/read', { input });
  }
  writeFile(input: FileWriteInput): Promise<FileWriteResult> {
    return this.call('files/write', { input });
  }
  applyPatch(input: PatchInput): Promise<PatchResult> {
    return this.call('files/patch', { input });
  }
  listFiles(input: ListFilesInput): Promise<FileTree> {
    return this.call('files/tree', { input });
  }
  exposePort(input: ExposePortInput): Promise<PreviewEndpoint> {
    return this.call('ports/expose', { input });
  }
  revokePort(port: number): Promise<void> {
    return this.call('ports/revoke', { port });
  }
}

export class SelfHostedSandboxProvider implements SandboxProvider {
  readonly kind = 'self-hosted' as const;
  readonly version = '0.1.0';

  constructor(private readonly config: SelfHostedConfig) {}

  async healthCheck(): Promise<SandboxHealth> {
    try {
      // Short timeout: a health probe must not hang the create path.
      const report = await request<{ healthy: boolean; checks?: SandboxHealth['checks']; detail?: string }>(
        { ...this.config, timeoutMs: Math.min(this.config.timeoutMs ?? 8_000, 8_000) },
        '/v1/health',
        {}
      );
      return {
        healthy: Boolean(report.healthy),
        kind: this.kind,
        checks: report.checks ?? [],
        detail: report.detail
      };
    } catch (error) {
      return {
        healthy: false,
        kind: this.kind,
        checks: [{ name: 'reachable', ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : 'unreachable' }],
        detail: 'Self-hosted agent did not pass its health check; falling back to Cloudflare.'
      };
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const result = await request<{ providerId: string }>(this.config, '/v1/sandboxes', { input });
    return new SelfHostedSandboxHandle(this.config, result.providerId || input.providerId);
  }

  async get(providerId: string): Promise<SandboxHandle> {
    return new SelfHostedSandboxHandle(this.config, providerId);
  }

  async suspend(providerId: string): Promise<void> {
    await request(this.config, `/v1/sandboxes/${encodeURIComponent(providerId)}/suspend`, {});
  }

  async resume(providerId: string): Promise<SandboxHandle> {
    await request(this.config, `/v1/sandboxes/${encodeURIComponent(providerId)}/resume`, {});
    return new SelfHostedSandboxHandle(this.config, providerId);
  }

  async destroy(providerId: string): Promise<void> {
    await request(this.config, `/v1/sandboxes/${encodeURIComponent(providerId)}/destroy`, {});
  }

  async snapshot(providerId: string, input: SnapshotInput): Promise<SnapshotRef> {
    return request<SnapshotRef>(this.config, `/v1/sandboxes/${encodeURIComponent(providerId)}/snapshot`, { input });
  }

  async restore(snapshot: SnapshotRef, input: CreateSandboxInput): Promise<SandboxHandle> {
    const result = await request<{ providerId: string }>(this.config, '/v1/sandboxes/restore', { snapshot, input });
    return new SelfHostedSandboxHandle(this.config, result.providerId || input.providerId);
  }
}
