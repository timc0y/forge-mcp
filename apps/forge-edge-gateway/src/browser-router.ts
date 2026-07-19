import type { ArtifactStore } from '@forge/artifacts-core';
import type { BrowserProvider } from '@forge/browser-core';
import { CloudflareBrowserProvider } from '@forge/browser-cloudflare';
import { SelfHostedBrowserProvider } from '@forge/browser-selfhosted';
import type { TenantId } from '@forge/core';
import type { Env } from './env';

// Cache the (flaky) self-hosted Chrome health per isolate so we don't probe on
// every browser call — just often enough to notice it recovering or dying.
const HEALTH_TTL_MS = 60_000;
let browserHealth: { at: number; healthy: boolean } | null = null;

function selfHostEnabled(env: Env): boolean {
  return (
    (env.FORGE_SELFHOST_ENABLED === 'true' || env.FORGE_SELFHOST_ENABLED === '1') &&
    Boolean(env.FORGE_SELFHOST_URL) &&
    Boolean(env.FORGE_SELFHOST_TOKEN)
  );
}

// Use the self-hosted agent's Chrome when it is configured and currently
// healthy, otherwise Cloudflare Browser Run. When self-host is unconfigured this
// returns exactly the Cloudflare provider, unchanged.
export async function selectBrowserProvider(
  env: Env,
  artifacts: ArtifactStore,
  tenantId: TenantId,
  // Only preview captures (a workspace's own Forge preview) may render on the
  // self-hosted machine. Arbitrary-URL forge_review must NOT — otherwise a
  // caller could screenshot the owner's LAN (router, NAS) via the mini's Chrome.
  allowSelfHosted = true,
  now: number = Date.now()
): Promise<BrowserProvider> {
  const cloudflare = new CloudflareBrowserProvider(env.BROWSER, artifacts, tenantId);
  if (!allowSelfHosted || !selfHostEnabled(env)) return cloudflare;
  const selfHosted = new SelfHostedBrowserProvider(
    { baseUrl: env.FORGE_SELFHOST_URL as string, token: env.FORGE_SELFHOST_TOKEN as string },
    artifacts,
    tenantId
  );
  if (!browserHealth || now - browserHealth.at > HEALTH_TTL_MS) {
    browserHealth = { at: now, healthy: await selfHosted.healthy() };
    if (!browserHealth.healthy) {
      console.warn('forge_browser_route_fallback', { chosen: 'cloudflare', reason: 'self-hosted chrome unhealthy' });
    }
  }
  return browserHealth.healthy ? selfHosted : cloudflare;
}
