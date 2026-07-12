import { ForgeError } from '@forge/core';

const privateRanges = [
  /^127\./, /^10\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^::1$/i, /^fc/i, /^fd/i, /^fe80:/i
];

export function assertPublicHost(host: string): void {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.local') || privateRanges.some((rule) => rule.test(normalized))) {
    throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Private and metadata network targets are blocked.', retryable: false, details: { host: normalized } });
  }
}
