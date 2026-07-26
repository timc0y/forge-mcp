import { describe, expect, it } from 'vitest';
import { ForgeApplicationService } from '@forge/application';
import type { ExecResult, SandboxHandle, SandboxProvider } from '@forge/sandbox-core';

interface ExecInput {
  command: string;
  environment?: Record<string, string>;
}

function serviceRecordingExecs(commands: ExecInput[], stdout: string): ForgeApplicationService {
  const handle = {
    exec: async (input: ExecInput): Promise<ExecResult> => {
      commands.push(input);
      return { exitCode: 0, stdout, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] };
    }
  } as unknown as SandboxHandle;
  const provider = {
    kind: 'local-docker',
    version: 'test',
    get: async () => handle
  } as unknown as SandboxProvider;
  return new ForgeApplicationService(provider);
}

function committableRecord(service: ForgeApplicationService) {
  const record = service.initializeWorkspace({
    tenantId: 'ten_00000000000000000000000000' as never,
    projectId: 'prj_00000000000000000000000000' as never,
    repository: { provider: 'github', owner: 'acme', name: 'app' },
    ref: 'main',
    runtimeProfile: 'node-22',
    persistence: 'ephemeral',
    bootstrap: false,
    idempotencyKey: 'seed-idempotency-key',
    actor: { type: 'agent', id: 'agent' }
  });
  record.workspace.state = 'ready';
  record.workspace.currentBranch = 'forge/tim/fix';
  return record;
}

describe('gitCommit fused exec', () => {
  it('stages, commits and reads HEAD in a single container round-trip', async () => {
    const commands: ExecInput[] = [];
    const head = 'a'.repeat(40);
    const service = serviceRecordingExecs(commands, `[forge/tim/fix abc1234] msg\n${head}\n`);
    const record = committableRecord(service);

    const result = await service.gitCommit(record, {
      message: 'do the thing',
      paths: ['src/a.ts', 'src/b.ts'],
      idempotencyKey: 'commit-key'
    });

    expect(commands).toHaveLength(1);
    const [only] = commands;
    expect(only.command).toContain('git add -- ');
    expect(only.command).toContain('git commit -m ');
    expect(only.command).toContain('git rev-parse HEAD');
    expect(only.environment?.GIT_AUTHOR_NAME).toBe('forge-mcp[bot]');
    // HEAD is parsed from the last line of the combined stdout.
    expect(result.commit).toBe(head);
    expect(record.workspace.currentCommit).toBe(head);
    expect(record.workspace.hasUnpushedWork).toBe(true);
  });
});
