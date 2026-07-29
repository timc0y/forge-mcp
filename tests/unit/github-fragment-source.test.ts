import { describe, expect, it } from 'vitest';
import type { GitHubRequest } from '@forge/git-github';
import { readFragmentSource } from '../../apps/forge-edge-gateway/src/github-fragment-source';

describe('readFragmentSource', () => {
  it('reads the exact base commit when the workspace branch is not remote yet', async () => {
    const calls: string[] = [];
    const request: GitHubRequest = async (path) => {
      calls.push(path);
      if (path.includes('/git/ref/heads/')) return { status: 404, json: {} };
      if (path.endsWith('?ref=base-sha')) return { status: 200, json: { content: 'YmFzZQ==', sha: 'base-blob' } };
      return { status: 404, json: {} };
    };

    const result = await readFragmentSource(request, {
      base: '/repos/acme/app', branch: 'forge/new', baseSha: 'base-sha', path: 'src/a.ts'
    });

    expect(calls).toEqual([
      '/repos/acme/app/contents/src/a.ts?ref=forge%2Fnew',
      '/repos/acme/app/git/ref/heads/forge/new',
      '/repos/acme/app/contents/src/a.ts?ref=base-sha'
    ]);
    expect(result).toEqual({ ok: true, body: { content: 'YmFzZQ==', sha: 'base-blob' }, sourceRef: 'base-sha', branchMissing: true });
  });

  it('does not fall back when the feature ref exists and the file is absent', async () => {
    const request: GitHubRequest = async (path) => path.includes('/git/ref/heads/')
      ? { status: 200, json: { object: { sha: 'tip' } } }
      : { status: 404, json: {} };

    const result = await readFragmentSource(request, {
      base: '/repos/acme/app', branch: 'forge/new', baseSha: 'base-sha', path: 'missing.ts'
    });
    expect(result).toEqual({ ok: false, kind: 'file_missing', sourceRef: 'forge/new', branchMissing: false });
  });

  it('preserves provider failures instead of calling them missing files', async () => {
    const request: GitHubRequest = async () => ({ status: 503, json: {} });
    const result = await readFragmentSource(request, {
      base: '/repos/acme/app', branch: 'forge/new', baseSha: 'base-sha', path: 'src/a.ts'
    });
    expect(result).toEqual({ ok: false, kind: 'provider', status: 503, operation: 'content', sourceRef: 'forge/new' });
  });
});
