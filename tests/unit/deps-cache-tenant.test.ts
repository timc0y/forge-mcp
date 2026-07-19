import { describe, expect, it } from 'vitest';
import { depsCacheKey, parseDepsCacheKey } from '../../apps/forge-edge-gateway/src/deps-cache';

// Regression tests for the cross-tenant deps-cache isolation fix. node_modules
// trees are executable, so two tenants that clone the same public repo at the
// same lockfile must resolve to DIFFERENT cache keys and DIFFERENT R2 paths.
const HASH = 'a'.repeat(64);
const TENANT_A = 'ten_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const TENANT_B = 'ten_bbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('deps-cache tenant isolation', () => {
  it('produces distinct cacheKey and r2Key per tenant for the same repo+lockfile', () => {
    const a = depsCacheKey(TENANT_A, 'acme/widgets', HASH, 'node-22');
    const b = depsCacheKey(TENANT_B, 'acme/widgets', HASH, 'node-22');
    expect(a.cacheKey).not.toBe(b.cacheKey);
    expect(a.r2Key).not.toBe(b.r2Key);
    expect(a.r2Key.startsWith(`deps/${TENANT_A}/`)).toBe(true);
    expect(b.r2Key.startsWith(`deps/${TENANT_B}/`)).toBe(true);
  });

  it('embeds the tenant as the first cacheKey component and first r2 path segment', () => {
    const { cacheKey, r2Key } = depsCacheKey(TENANT_A, 'acme/widgets', HASH, 'node-22');
    expect(cacheKey).toBe(`${TENANT_A}|acme/widgets|node-22|${HASH}`);
    expect(r2Key).toBe(`deps/${TENANT_A}/acme/widgets/node-22/${HASH}.tar.gz`);
  });

  it('round-trips the tenant id and keeps its r2 key inside that tenant prefix', () => {
    const { cacheKey } = depsCacheKey(TENANT_A, 'acme/widgets', HASH, 'node-22');
    const parsed = parseDepsCacheKey(cacheKey);
    expect(parsed?.tenantId).toBe(TENANT_A);
    expect(parsed?.r2Key.startsWith(`deps/${TENANT_A}/`)).toBe(true);
  });

  it('parsing a key never lets one tenant reach another tenant\'s object', () => {
    // A well-formed key for tenant B parses to tenant B's r2Key only; there is no
    // representation that maps tenant A's identity onto tenant B's stored tree.
    const b = depsCacheKey(TENANT_B, 'acme/widgets', HASH, 'node-22');
    const parsed = parseDepsCacheKey(b.cacheKey);
    expect(parsed?.r2Key).toBe(b.r2Key);
    expect(parsed?.r2Key.includes(TENANT_A)).toBe(false);
  });

  it('rejects tenant components that attempt path traversal or delimiter injection', () => {
    expect(parseDepsCacheKey(`..|acme/widgets|node-22|${HASH}`)).toBeNull();
    expect(parseDepsCacheKey(`a/b|acme/widgets|node-22|${HASH}`)).toBeNull();
    expect(parseDepsCacheKey(`|acme/widgets|node-22|${HASH}`)).toBeNull();
  });
});
