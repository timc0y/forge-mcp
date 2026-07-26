import { ForgeError } from '@forge/core';

export function mapCloudflareSandboxError(error: unknown, operation: string): ForgeError {
  const value = error as { code?: unknown; message?: unknown };
  const providerCode = typeof value?.code === 'string' ? value.code : 'UNKNOWN';
  const message = typeof value?.message === 'string' ? value.message : 'Unknown sandbox provider failure';
  const timeout = /timeout/i.test(message) || providerCode.includes('TIMEOUT');
  // Missing paths are an expected outcome of a file read, not an opaque
  // provider outage. Preserve that distinction so recovery can safely tell an
  // empty post-sleep image scaffold from a live worktree without parsing a
  // shell error or exposing raw provider text to clients.
  const fileNotFound = operation === 'readFile' && (
    /(?:NOT[ _-]?FOUND|ENOENT|NO_SUCH_FILE)/iu.test(providerCode) ||
    /(?:not found|no such file|enoent)/iu.test(message)
  );
  return new ForgeError({
    code: fileNotFound ? 'FORGE_FILE_NOT_FOUND' : timeout ? 'FORGE_COMMAND_TIMEOUT' : 'FORGE_PROVIDER_UNAVAILABLE',
    message: fileNotFound
      ? 'Sandbox file was not found.'
      : timeout ? `Sandbox operation ${operation} timed out.` : `Sandbox operation ${operation} failed.`,
    retryable: !fileNotFound && (timeout || /unavailable|interrupted|container/i.test(message)),
    details: { provider: 'cloudflare', providerCode, operation }
  });
}
