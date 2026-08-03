import { describe, expect, it } from 'vitest';
import { assertSameOrigin, forgeOrigin } from '../../apps/forge-edge-gateway/src/github';
import type { Env } from '../../apps/forge-edge-gateway/src/env';

const CANONICAL = 'https://forge.timcoy.uk';
const OTHER = 'https://forge-edge-gateway.timcoy72.workers.dev';

const env = { FORGE_PUBLIC_ORIGIN: CANONICAL } as unknown as Env;

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

  it('rejects a foreign origin', () => {
    expect(() => assertSameOrigin(post(`${CANONICAL}/approvals/apr_x`, 'https://evil.example'), env)).toThrow();
    expect(() => assertSameOrigin(post(`${CANONICAL}/approvals/apr_x`, `${CANONICAL}.evil.example`), env)).toThrow();
    expect(() => assertSameOrigin(post(`${CANONICAL}/approvals/apr_x`, OTHER), env)).toThrow();
  });

  it('allows a request with no Origin header, as browsers omit it for same-origin GETs', () => {
    expect(() => assertSameOrigin(post(`${CANONICAL}/approvals/apr_x`), env)).not.toThrow();
  });
});

describe('forgeOrigin', () => {
  it('returns the public origin for a matching request host', () => {
    expect(forgeOrigin(post(`${CANONICAL}/approvals/apr_x`), env)).toBe(CANONICAL);
  });

  it('falls back to the public origin for an unrecognised host', () => {
    // The Host header is attacker-controlled and this value lands in an OAuth
    // redirect_uri, so an unknown host must never be echoed back.
    expect(forgeOrigin(post('https://evil.example/approvals/apr_x'), env)).toBe(CANONICAL);
    expect(forgeOrigin(post(`${OTHER}/approvals/apr_x`), env)).toBe(CANONICAL);
  });
});

describe('Origin: null (sandboxed webviews)', () => {
  it('is treated like a missing header in sandboxed contexts', () => {
    expect(() => assertSameOrigin(post(`${CANONICAL}/approvals/apr_x`, 'null'), env)).not.toThrow();
  });
});
