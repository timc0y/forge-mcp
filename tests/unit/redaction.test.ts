import { describe, expect, it } from 'vitest';
import { redact } from '@forge/audit';

describe('audit redaction', () => {
  it('removes common credentials before persistence', () => {
    const value = redact('authorization: Bearer secret-token-value github_pat_abcdefghijklmnopqrstuvwxyz123456');
    expect(value).not.toContain('secret-token-value');
    expect(value).not.toContain('github_pat_');
    expect(value).toContain('[REDACTED]');
  });
});
