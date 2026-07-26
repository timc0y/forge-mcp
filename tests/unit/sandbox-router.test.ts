import { describe, expect, it } from 'vitest';
import { sandboxRouter } from '../../apps/forge-edge-gateway/src/sandbox-router';
import type { SandboxProvider, SandboxHealth } from '@forge/sandbox-core';

function provider(
  kind: SandboxProvider['kind'],
  health?: boolean,
  capacity?: { max: number; inUse: number }
): SandboxProvider {
  return {
    kind,
    version: 'test',
    ...(health === undefined
      ? {}
      : { healthCheck: async (): Promise<SandboxHealth> => ({ healthy: health, kind, checks: [], capacity }) }),
    create: async () => ({}) as never,
    get: async () => ({}) as never,
    suspend: async () => undefined,
    resume: async () => ({}) as never,
    destroy: async () => undefined,
    snapshot: async () => ({}) as never,
    restore: async () => ({}) as never
  } as SandboxProvider;
}

describe('sandbox router selection and fallback', () => {
  it('uses Cloudflare when no self-hosted backend is configured', async () => {
    const router = sandboxRouter({ cloudflare: provider('cloudflare') });
    expect((await router.selectForCreate()).kind).toBe('cloudflare');
    expect(router.default.kind).toBe('cloudflare');
  });

  it('routes new workspaces to a healthy self-hosted backend', async () => {
    const router = sandboxRouter({ cloudflare: provider('cloudflare'), selfHosted: provider('self-hosted', true) });
    expect((await router.selectForCreate()).kind).toBe('self-hosted');
  });

  it('falls back to Cloudflare when the self-hosted backend is unhealthy', async () => {
    const router = sandboxRouter({ cloudflare: provider('cloudflare'), selfHosted: provider('self-hosted', false) });
    expect((await router.selectForCreate()).kind).toBe('cloudflare');
  });

  it('falls back to Cloudflare when the self-hosted backend is at capacity', async () => {
    const full = sandboxRouter({ cloudflare: provider('cloudflare'), selfHosted: provider('self-hosted', true, { max: 4, inUse: 4 }) });
    expect((await full.selectForCreate()).kind).toBe('cloudflare');
    const room = sandboxRouter({ cloudflare: provider('cloudflare'), selfHosted: provider('self-hosted', true, { max: 4, inUse: 1 }) });
    expect((await room.selectForCreate()).kind).toBe('self-hosted');
  });

  it('resolves an existing workspace to the backend it was created on', () => {
    const router = sandboxRouter({ cloudflare: provider('cloudflare'), selfHosted: provider('self-hosted', true) });
    expect(router.forKind('self-hosted').kind).toBe('self-hosted');
    expect(router.forKind('cloudflare').kind).toBe('cloudflare');
  });

  it('errors clearly if a self-hosted workspace is resolved while the backend is gone', () => {
    const router = sandboxRouter({ cloudflare: provider('cloudflare') });
    expect(() => router.forKind('self-hosted')).toThrowError(/self-hosted backend/i);
  });
});
