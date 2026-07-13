import { describe, expect, it } from 'vitest';
import { buildDeterministicRepositoryIndex } from '@forge/repo-index';
import type { SandboxHandle } from '@forge/sandbox-core';

it('builds a commit-bound deterministic repository index', async () => {
  const handle = {
    providerId: 'fake',
    exec: async () => ({
      exitCode: 0,
      stdout: 'abc123\n--FILES--\nAGENTS.md\0package.json\0src/app.ts\0src/page.astro\0',
      stderr: '',
      truncated: false,
      durationMs: 1,
      artifactRefs: []
    })
  } as unknown as SandboxHandle;
  const index = await buildDeterministicRepositoryIndex(handle);
  expect(index.repositoryCommit).toBe('abc123');
  expect(index.languages).toEqual({ Astro: 1, JSON: 1, TypeScript: 1, Markdown: 1 });
  expect(index.instructions).toContain('AGENTS.md');
});
