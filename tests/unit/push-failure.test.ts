import { describe, expect, it } from 'vitest';
import { classifyPushFailure } from '@forge/application';

describe('classifyPushFailure', () => {
  it('maps capability pin mismatches', () => {
    expect(classifyPushFailure({ stderr: 'approved branch or commit does not match' })).toBe('capability_pin');
  });

  it('maps forge proxy 403', () => {
    expect(classifyPushFailure({ stderr: 'HTTP 403 Forbidden' })).toBe('forge_proxy');
  });

  it('maps permission denied to auth', () => {
    expect(classifyPushFailure({ forgeErrorCode: 'FORGE_PERMISSION_DENIED' })).toBe('auth');
  });

  it('treats disabled auto-push as not applicable', () => {
    expect(classifyPushFailure({ reason: 'disabled' })).toBe('not_applicable');
  });
});
