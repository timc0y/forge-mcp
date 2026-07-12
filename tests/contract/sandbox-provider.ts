import { expect } from 'vitest';
import type { SandboxProvider } from '@forge/sandbox-core';

export async function exerciseSandboxProvider(provider: SandboxProvider): Promise<void> {
  const handle = await provider.create({
    providerId: 'forge-contract-test',
    runtimeProfile: 'node-22',
    labels: { suite: 'contract' },
    idleTimeout: '5m'
  });
  try {
    const execution = await handle.exec({
      command: "printf 'forge-contract'",
      cwd: '/workspace',
      timeoutMs: 30_000,
      outputLimitBytes: 10_000,
      sessionId: 'system',
      networkPolicy: 'deny_all'
    });
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout).toContain('forge-contract');
    await handle.writeFile({ path: '/workspace/repo/example.txt', content: 'hello' });
    const read = await handle.readFile({ path: '/workspace/repo/example.txt', maxBytes: 10_000 });
    expect(read.content).toBe('hello');
  } finally {
    await provider.destroy(handle.providerId);
  }
}
