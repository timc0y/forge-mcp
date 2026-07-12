import { ForgeError } from '@forge/core';

export function providerUnavailable(message = 'The workspace runtime is unavailable.'): ForgeError {
  return new ForgeError({ code: 'FORGE_PROVIDER_UNAVAILABLE', message, retryable: true });
}
