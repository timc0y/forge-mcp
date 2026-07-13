import { describe, expect, it } from 'vitest';
import { constantTimeEqual } from '../../apps/forge-edge-gateway/src/auth';

describe('constantTimeEqual', () => {
  it('accepts only byte-identical values', () => {
    expect(constantTimeEqual('internal-preview-key', 'internal-preview-key')).toBe(true);
    expect(constantTimeEqual('internal-preview-key', 'internal-preview-kez')).toBe(false);
    expect(constantTimeEqual('short', 'longer')).toBe(false);
  });
});
