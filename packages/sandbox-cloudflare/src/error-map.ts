import { ForgeError } from '@forge/core';

export function mapCloudflareSandboxError(error: unknown, operation: string): ForgeError {
  const value = error as { code?: unknown; message?: unknown };
  const providerCode = typeof value?.code === 'string' ? value.code : 'UNKNOWN';
  const message = typeof value?.message === 'string' ? value.message : 'Unknown sandbox provider failure';
  const timeout = /timeout/i.test(message) || providerCode.includes('TIMEOUT');
  return new ForgeError({
    code: timeout ? 'FORGE_COMMAND_TIMEOUT' : 'FORGE_PROVIDER_UNAVAILABLE',
    message: timeout ? `Sandbox operation ${operation} timed out.` : `Sandbox operation ${operation} failed.`,
    retryable: timeout || /unavailable|interrupted|container/i.test(message),
    details: { provider: 'cloudflare', providerCode, operation }
  });
}
