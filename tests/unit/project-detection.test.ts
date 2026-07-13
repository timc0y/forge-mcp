import { describe, expect, it } from 'vitest';
import { detectProject } from '@forge/project-detection';
import type { SandboxHandle } from '@forge/sandbox-core';

function fake(stdout: string): SandboxHandle {
  return {
    providerId: 'fake',
    exec: async () => ({ exitCode: 0, stdout, stderr: '', truncated: false, durationMs: 1, artifactRefs: [] }),
    startProcess: async () => { throw new Error('unused'); },
    getProcess: async () => null,
    readProcessLogs: async () => ({ data: '', truncated: false }),
    stopProcess: async () => undefined,
    readFile: async () => { throw new Error('unused'); },
    writeFile: async () => { throw new Error('unused'); },
    applyPatch: async () => { throw new Error('unused'); },
    listFiles: async () => ({ entries: [], truncated: false }),
    exposePort: async () => { throw new Error('unused'); },
    revokePort: async () => undefined
  };
}

describe('project detection', () => {
  it('detects pnpm Astro projects deterministically', async () => {
    const result = await detectProject(
      fake(JSON.stringify({ pm: 'pnpm', framework: 'astro', scripts: { dev: 'astro dev', build: 'astro build' } }))
    );
    expect(result).toEqual({
      packageManager: 'pnpm',
      framework: 'astro',
      installCommand: 'pnpm install --frozen-lockfile',
      devCommand: 'pnpm run dev',
      buildCommand: 'pnpm run build',
      expectedPorts: [4321]
    });
  });
});
