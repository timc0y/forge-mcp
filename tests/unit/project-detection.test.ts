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
      expectedPorts: [4321],
      devCwd: '/workspace/repo',
      installCwd: '/workspace/repo',
      lockfilePath: null,
      previewConfig: null,
      previewConfigFile: null,
      previewConfigError: null
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
      expectedPorts: [5173],
      devCwd: '/workspace/repo',
      installCwd: '/workspace/repo',
      lockfilePath: null,
      previewConfig: null,
      previewConfigFile: null,
      previewConfigError: null
    });
  });

  it('maps sveltekit and nuxt projects to their expected ports', () => {
    expect(parseDetection(JSON.stringify({ pm: 'pnpm', framework: 'sveltekit', scripts: { dev: 'vite dev' } })).expectedPorts).toEqual([5173]);
    expect(parseDetection(JSON.stringify({ pm: 'pnpm', framework: 'nuxt', scripts: { dev: 'nuxt dev' } })).expectedPorts).toEqual([3000]);
  });

  it('falls back to npm run for an unknown package manager with scripts', () => {
    const detection = parseDetection(JSON.stringify({ pm: 'unknown', framework: null, scripts: { dev: 'x' } }));
    expect(detection.installCommand).toBeNull();
    expect(detection.devCommand).toBe('npm run dev');
    expect(detection.buildCommand).toBeNull();
    expect(detection.expectedPorts).toEqual([]);
  });

  it('uses a repository Forge config for a nested app, exact command, and port', () => {
    const detection = parseDetection(JSON.stringify({
      pm: 'pnpm',
      framework: 'vite',
      scripts: { dev: 'vite', build: 'vite build' },
      installCwd: '.',
      lockfilePath: 'pnpm-lock.yaml',
      forgeConfig: {
        preview: {
          cwd: 'apps/web',
          command: 'pnpm dev --host 0.0.0.0',
          port: 4173
        }
      },
      forgeConfigFile: 'forge.json'
    }));

    expect(detection).toMatchObject({
      packageManager: 'pnpm',
      devCommand: 'pnpm dev --host 0.0.0.0',
      devCwd: '/workspace/repo/apps/web',
      installCwd: '/workspace/repo',
      lockfilePath: 'pnpm-lock.yaml',
      expectedPorts: [4173],
      previewConfig: { cwd: 'apps/web', command: 'pnpm dev --host 0.0.0.0', port: 4173 },
      previewConfigFile: 'forge.json',
      previewConfigError: null
    });
  });

  it('keeps installation beside a nested lockfile when the repository root has none', () => {
    const detection = parseDetection(JSON.stringify({
      pm: 'npm',
      framework: null,
      scripts: { dev: 'node server.js' },
      installCwd: 'apps/web',
      lockfilePath: 'package-lock.json',
      forgeConfig: { preview: { cwd: 'apps/web', port: 8080 } },
      forgeConfigFile: 'forge.config.json'
    }));

    expect(detection).toMatchObject({
      devCommand: 'npm run dev',
      devCwd: '/workspace/repo/apps/web',
      installCwd: '/workspace/repo/apps/web',
      lockfilePath: 'package-lock.json',
      expectedPorts: [8080]
    });
  });

  it('reports unsafe Forge config instead of launching outside the checkout', () => {
    const detection = parseDetection(JSON.stringify({
      pm: 'pnpm',
      framework: 'vite',
      scripts: { dev: 'vite' },
      forgeConfig: { preview: { cwd: '../secret', port: 5173 } },
      forgeConfigFile: 'forge.json'
    }));

    expect(detection.previewConfigError).toContain('inside the repository');
    expect(detection.devCommand).toBe('pnpm run dev');
    expect(detection.devCwd).toBe('/workspace/repo');
  });

  it('returns the unknown default on unparseable output', () => {
    expect(parseDetection('not json')).toEqual({
      packageManager: 'unknown',
      framework: null,
      installCommand: null,
      installFallbackCommand: null,
      devCommand: null,
      buildCommand: null,
      expectedPorts: [],
      devCwd: '/workspace/repo',
      installCwd: '/workspace/repo',
      lockfilePath: null,
      previewConfig: null,
      previewConfigFile: null,
      previewConfigError: null
    });
  });

  it('returns the unknown default for valid JSON that is not a detection object', () => {
    expect(parseDetection('null')).toMatchObject({
      packageManager: 'unknown',
      devCommand: null,
      devCwd: '/workspace/repo',
      installCwd: '/workspace/repo'
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
      '===FORGE_DETECTION===',
      JSON.stringify({ pm: 'pnpm', framework: 'nextjs', scripts: { dev: 'next dev' } })
    ].join('\n');
    const probe = parseProvisionProbe(stdout);
    expect(probe.head).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(probe.branch).toBe('main');
    expect(probe.detection.packageManager).toBe('pnpm');
    expect(probe.detection.installCommand).toBe('pnpm install --frozen-lockfile --prefer-offline');
    expect(probe.detection.expectedPorts).toEqual([3000]);
  });

  it('yields empty sections and an unknown detection when markers are absent', () => {
    const probe = parseProvisionProbe('');
    expect(probe.head).toBe('');
    expect(probe.branch).toBe('');
    expect(probe.detection.packageManager).toBe('unknown');
  });

  it('handles a detached HEAD with an empty branch', () => {
    const probe = parseProvisionProbe(
      [
        '===FORGE_HEAD===',
        'cafebabe',
        '===FORGE_BRANCH===',
        '',
        '===FORGE_DETECTION===',
        JSON.stringify({ pm: 'unknown', framework: null, scripts: {} })
      ].join('\n')
    );
    expect(probe.head).toBe('cafebabe');
    expect(probe.branch).toBe('');
  });
});
