import { ForgeError } from '@forge/core';
import type { SandboxRouter } from '@forge/application';
import type { SandboxProvider } from '@forge/sandbox-core';

// Route new workspaces to a self-hosted backend when it is configured AND passes
// its health check, otherwise to Cloudflare. Existing workspaces always route to
// the backend they were created on (read from the persisted provider.kind). The
// MCP caller never sees which backend ran — Forge chooses.
//
// Pure by design: it takes provider instances and imports no concrete provider,
// so it can be unit-tested without the Workers runtime. The env wiring that
// builds the real providers lives in sandbox-router-env.ts.
export function sandboxRouter(providers: {
  cloudflare: SandboxProvider;
  selfHosted?: SandboxProvider;
}): SandboxRouter {
  const { cloudflare, selfHosted } = providers;
  return {
    // Cloudflare is the default backend a record is stamped with until create()
    // finalises the real choice — so a workspace never defaults to a self-hosted
    // kind that might be unavailable.
    default: cloudflare,
    async selectForCreate() {
      if (!selfHosted?.healthCheck) return cloudflare;
      const health = await selfHosted.healthCheck();
      const atCapacity = health.capacity !== undefined && health.capacity.inUse >= health.capacity.max;
      if (health.healthy && !atCapacity) {
        console.log('forge_sandbox_route', { chosen: 'self-hosted', capacity: health.capacity });
        return selfHosted;
      }
      console.warn('forge_sandbox_route_fallback', {
        chosen: 'cloudflare',
        reason: atCapacity ? 'self-hosted at capacity' : health.detail ?? 'self-hosted health check failed',
        capacity: health.capacity,
        checks: health.checks
      });
      return cloudflare;
    },
    forKind(kind) {
      if (kind === 'self-hosted') {
        if (!selfHosted) {
          throw new ForgeError({
            code: 'FORGE_PROVIDER_UNAVAILABLE',
            message: 'This workspace runs on a self-hosted backend that is not currently configured.',
            retryable: false
          });
        }
        return selfHosted;
      }
      return cloudflare;
    }
  };
}
