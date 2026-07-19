import type { SandboxRouter } from '@forge/application';
import { CloudflareSandboxProvider } from '@forge/sandbox-cloudflare';
import { SelfHostedSandboxProvider } from '@forge/sandbox-selfhosted';
import type { Env } from './env';
import { sandboxRouter } from './sandbox-router';

// Build the real router from env: always Cloudflare, plus the self-hosted
// backend when it is enabled and fully configured. Unconfigured means
// Cloudflare-only — byte-for-byte the previous behaviour.
export function createSandboxRouter(env: Env): SandboxRouter {
  const cloudflare = new CloudflareSandboxProvider(env);
  const enabled = env.FORGE_SELFHOST_ENABLED === 'true' || env.FORGE_SELFHOST_ENABLED === '1';
  const selfHosted =
    enabled && env.FORGE_SELFHOST_URL && env.FORGE_SELFHOST_TOKEN
      ? new SelfHostedSandboxProvider({ baseUrl: env.FORGE_SELFHOST_URL, token: env.FORGE_SELFHOST_TOKEN })
      : undefined;
  return sandboxRouter({ cloudflare, selfHosted });
}
