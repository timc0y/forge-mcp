import { describe, expect, it } from 'vitest';
import { detectProject, parseDetection } from '@forge/project-detection';
import { parseProvisionProbe } from '@forge/application';
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
      installCommand: 'pnpm install --frozen-lockfile --prefer-offline',
      installFallbackCommand: 'pnpm install --no-frozen-lockfile --prefer-offline',
      devCommand: 'pnpm run dev',
      buildCommand: 'pnpm run build',
      expectedPorts: [4321]
    });
  });
});

describe('parseDetection', () => {
  it('maps a pnpm + vite project to its commands and port', () => {
    expect(
      parseDetection(JSON.stringify({ pm: 'pnpm', framework: 'vite', scripts: { dev: 'vite', build: 'vite build' } }))
    ).toEqual({
      packageManager: 'pnpm',
      framework: 'vite',
      installCommand: 'pnpm install --frozen-lockfile --prefer-offline',
      installFallbackCommand: 'pnpm install --no-frozen-lockfile --prefer-offline',
      devCommand: 'pnpm run dev',
      buildCommand: 'pnpm run build',
      expectedPorts: [5173]
    });
  });

  it('falls back to npm run for an unknown package manager with scripts', () => {
    const detection = parseDetection(JSON.stringify({ pm: 'unknown', framework: null, scripts: { dev: 'x' } }));
    expect(detection.installCommand).toBeNull();
    expect(detection.devCommand).toBe('npm run dev');
    expect(detection.buildCommand).toBeNull();
    expect(detection.expectedPorts).toEqual([]);
  });

  it('returns the unknown default on unparseable output', () => {
    expect(parseDetection('not json')).toEqual({
      packageManager: 'unknown',
      framework: null,
      installCommand: null,
      installFallbackCommand: null,
      devCommand: null,
      buildCommand: null,
      expectedPorts: []
    });
  });
});

describe('parseProvisionProbe', () => {
  it('splits every sentinel section of the combined block', () => {
    const stdout = [
      '===FORGE_HEAD===',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      '===FORGE_BRANCH===',
      'main',
      '===FORGE_LOCKFILE===',
      `pnpm-lock.yaml ${'a'.repeat(64)}`,
      `package-lock.json ${'b'.repeat(64)}`,
      '===FORGE_DETECTION===',
      JSON.stringify({ pm: 'pnpm', framework: 'nextjs', scripts: { dev: 'next dev' } })
    ].join('\n');
    const probe = parseProvisionProbe(stdout);
    expect(probe.head).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(probe.branch).toBe('main');
    expect(probe.lockfileHashes['pnpm-lock.yaml']).toBe('a'.repeat(64));
    expect(probe.lockfileHashes['package-lock.json']).toBe('b'.repeat(64));
    expect(probe.detection.packageManager).toBe('pnpm');
    expect(probe.detection.installCommand).toBe('pnpm install --frozen-lockfile --prefer-offline');
    expect(probe.detection.expectedPorts).toEqual([3000]);
  });

  it('yields empty sections and an unknown detection when markers are absent', () => {
    const probe = parseProvisionProbe('');
    expect(probe.head).toBe('');
    expect(probe.branch).toBe('');
    expect(probe.lockfileHashes).toEqual({});
    expect(probe.detection.packageManager).toBe('unknown');
  });

  it('handles a detached HEAD with an empty branch and no lockfiles', () => {
    const probe = parseProvisionProbe(
      [
        '===FORGE_HEAD===',
        'cafebabe',
        '===FORGE_BRANCH===',
        '',
        '===FORGE_LOCKFILE===',
        '===FORGE_DETECTION===',
        JSON.stringify({ pm: 'unknown', framework: null, scripts: {} })
      ].join('\n')
    );
    expect(probe.head).toBe('cafebabe');
    expect(probe.branch).toBe('');
    expect(probe.lockfileHashes).toEqual({});
  });
});
