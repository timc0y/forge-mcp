import { describe, expect, it } from 'vitest';
import { assertSameOrigin, forgeOrigin } from '../../apps/forge-edge-gateway/src/github';
import type { Env } from '../../apps/forge-edge-gateway/src/env';

const CANONICAL = 'https://forge.timcoy.uk';
const LEGACY = 'https://forge-edge-gateway.timcoy72.workers.dev';

const env = {
  FORGE_PUBLIC_ORIGIN: CANONICAL,
  FORGE_LEGACY_ORIGINS: LEGACY
} as unknown as Env;

const envNoLegacy = { FORGE_PUBLIC_ORIGIN: CANONICAL } as unknown as Env;

function post(url: string, origin?: string): Request {
  return new Request(url, {
    method: 'POST',
    ...(origin ? { headers: { origin } } : {})
  });
}

describe('assertSameOrigin', () => {
  it('accepts a form posted from the canonical origin', () => {
    expect(() => assertSameOrigin(post(`${CANONICAL}/approvals/apr_x`, CANONICAL), env)).not.toThrow();
  });

  it('accepts a form posted from a legacy origin', () => {
    // The regression: moving the canonical origin to a new domain made every
    // approval page still open on the old hostname unsubmittable. The page
    // rendered a working-looking Approve button and the POST returned 403.
    expect(() => assertSameOrigin(post(`${LEGACY}/approvals/apr_x`, LEGACY), env)).not.toThrow();
  });

  it('still rejects a genuinely foreign origin', () => {
    expect(() => assertSameOrigin(post(`${CANONICAL}/approvals/apr_x`, 'https://evil.example'), env)).toThrow();
    // A lookalike prefix must not pass either.
    expect(() => assertSameOrigin(post(`${CANONICAL}/approvals/apr_x`, `${CANONICAL}.evil.example`), env)).toThrow();
  });

  it('rejects the legacy origin when none is configured', () => {
    expect(() => assertSameOrigin(post(`${CANONICAL}/approvals/apr_x`, LEGACY), envNoLegacy)).toThrow();
  });

  it('allows a request with no Origin header, as browsers omit it for same-origin GETs', () => {
    expect(() => assertSameOrigin(post(`${CANONICAL}/approvals/apr_x`), env)).not.toThrow();
  });

  it('is not fooled by an empty entry in the legacy list', () => {
    const sloppy = { FORGE_PUBLIC_ORIGIN: CANONICAL, FORGE_LEGACY_ORIGINS: ' , ,' } as unknown as Env;
    expect(() => assertSameOrigin(post(`${CANONICAL}/x`, 'https://evil.example'), sloppy)).toThrow();
    expect(() => assertSameOrigin(post(`${CANONICAL}/x`, CANONICAL), sloppy)).not.toThrow();
  });
});

describe('forgeOrigin', () => {
  it('keeps the visitor on whichever Forge hostname they used', () => {
    expect(forgeOrigin(post(`${CANONICAL}/approvals/apr_x`), env)).toBe(CANONICAL);
    expect(forgeOrigin(post(`${LEGACY}/approvals/apr_x`), env)).toBe(LEGACY);
  });

  it('falls back to the canonical origin for an unrecognised host', () => {
    // The Host header is attacker-controlled and this value lands in an OAuth
    // redirect_uri, so an unknown host must never be echoed back.
    expect(forgeOrigin(post('https://evil.example/approvals/apr_x'), env)).toBe(CANONICAL);
  });

  it('falls back when no legacy origins are configured', () => {
    expect(forgeOrigin(post(`${LEGACY}/approvals/apr_x`), envNoLegacy)).toBe(CANONICAL);
  });
});
