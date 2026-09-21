import { ForgeError } from './errors';

export const HIGH_SEVERITY_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN [A-Z]+ PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9_]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
  /\bsk_live_[0-9a-zA-Z]{24,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*\b/
]);

export function containsHighSeveritySecret(text: string): boolean {
  return HIGH_SEVERITY_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function assertNoHighSeveritySecretText(text: string, operation: string): void {
  if (!containsHighSeveritySecret(text)) return;
  throw new ForgeError({
    code: 'FORGE_VALIDATION_FAILED',
    message: operation + ' refused because the content contains what appears to be an unredacted high-severity secret. No external request or GitHub write was made.'
  });
}
