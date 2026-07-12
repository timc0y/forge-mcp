import type { ForgeEvent } from '@forge/events';
const secretPatterns = [/[A-Za-z0-9_]{36,255}/g, /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, /authorization:\s*bearer\s+\S+/ig, /github_pat_[A-Za-z0-9_]+/g, /gh[opsu]_[A-Za-z0-9]+/g];
export function redact(value: string): string { return secretPatterns.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value); }
export interface AuditStore { append(event: ForgeEvent): Promise<void>; }
