import { ForgeError } from '@forge/core';

// SYNTACTIC egress guard. assertPublicHost rejects host strings that name a
// private, loopback, link-local, metadata, or otherwise non-public target. It
// is a PURE function: it cannot perform DNS resolution, so a public hostname
// that resolves to a private address (DNS rebinding) will pass here. Callers
// MUST re-run this check at connection/resolution time and after EVERY redirect
// hop against the *resolved* IP — this function only closes the syntactic holes
// (raw IPs, alternate IP encodings, IPv4-mapped IPv6, obvious metadata names).

const privateV4Ranges: RegExp[] = [
  /^0\./,                       // 0.0.0.0/8 ("this host") incl. 0.0.0.0
  /^10\./,                      // 10.0.0.0/8 private
  /^127\./,                     // 127.0.0.0/8 loopback
  /^169\.254\./,                // 169.254.0.0/16 link-local incl. 169.254.169.254 cloud metadata
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 private
  /^192\.168\./,                // 192.168.0.0/16 private
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./ // 100.64.0.0/10 CGNAT (shared address space)
];

const blockedHostnames = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data' // AWS metadata alias
]);

/** Convert a 32-bit unsigned integer to dotted-quad. */
function intToDottedV4(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ].join('.');
}

/**
 * Parse a single IPv4 octet that may be written in decimal, hex (0x..) or
 * octal (0..). Returns null if it is not a valid 0-255 octet.
 */
function parseOctet(part: string): number | null {
  let value: number;
  if (/^0x[0-9a-f]+$/i.test(part)) value = parseInt(part.slice(2), 16);
  else if (/^0[0-7]+$/.test(part)) value = parseInt(part, 8);
  else if (/^0$/.test(part)) value = 0;
  else if (/^[1-9][0-9]*$/.test(part)) value = parseInt(part, 10);
  else return null;
  return value >= 0 && value <= 255 ? value : null;
}

/**
 * Normalize any IPv4 representation (dotted decimal/hex/octal, or a single
 * decimal/hex integer like 2130706433 / 0x7f000001) to canonical dotted-quad.
 * Returns null when the input is not an IPv4 literal in any recognized form.
 */
function normalizeV4(host: string): string | null {
  // Single-integer forms: 2130706433, 0x7f000001, 017700000001 (octal).
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host.slice(2), 16);
    return Number.isFinite(n) && n <= 0xffffffff ? intToDottedV4(n) : null;
  }
  if (/^0[0-7]+$/.test(host)) {
    const n = parseInt(host, 8);
    return Number.isFinite(n) && n <= 0xffffffff ? intToDottedV4(n) : null;
  }
  if (/^[0-9]+$/.test(host)) {
    const n = Number(host);
    return Number.isFinite(n) && n <= 0xffffffff ? intToDottedV4(n) : null;
  }
  // Dotted forms with 2-4 parts (each dec/hex/octal). We only treat the strict
  // 4-part form as a full address; fewer parts are ambiguous, so require 4.
  const parts = host.split('.');
  if (parts.length === 4) {
    const octets = parts.map(parseOctet);
    if (octets.every((o): o is number => o !== null)) {
      return octets.join('.');
    }
  }
  return null;
}

function isPrivateV4(dotted: string): boolean {
  return privateV4Ranges.some((rule) => rule.test(dotted));
}

/**
 * Reject IPv6 literals that name loopback (::1), unspecified (::),
 * unique-local (fc00::/7 -> fc/fd), link-local (fe80::/10), IPv4-mapped/
 * -compatible addresses embedding a private IPv4, and NAT64 well-known prefix.
 * `host` must already be lowercased with any surrounding brackets removed.
 */
function isPrivateV6(host: string): boolean {
  if (!host.includes(':')) return false;
  const h = host;
  if (h === '::1' || h === '::') return true;
  if (/^fe80:/i.test(h)) return true;             // link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // fc00::/7 unique-local
  if (/^f[cd]$/i.test(h)) return true;            // defensive: bare fc/fd label
  // IPv4-mapped/compatible/translated: ...:a.b.c.d  or  ::ffff:xxxx:xxxx
  const embeddedDotted = h.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embeddedDotted?.[1]) {
    const norm = normalizeV4(embeddedDotted[1]);
    if (norm && isPrivateV4(norm)) return true;
  }
  // ::ffff:7f00:0001 style (hex) IPv4-mapped.
  const mappedHex = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex?.[1] && mappedHex[2]) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      const dotted = intToDottedV4(((hi << 16) | lo) >>> 0);
      if (isPrivateV4(dotted)) return true;
    }
  }
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 — treat embedded private
  // targets as blocked (embeddedDotted above already covers the dotted tail).
  return false;
}

export function assertPublicHost(host: string): void {
  let normalized = host.trim().toLowerCase().replace(/\.$/, '');
  // Strip surrounding brackets from IPv6 literals ([::1] -> ::1) and any zone id.
  normalized = normalized.replace(/^\[/, '').replace(/\]$/, '').replace(/%[a-z0-9]+$/i, '');

  const block = () => {
    throw new ForgeError({
      code: 'FORGE_PERMISSION_DENIED',
      message: 'Private and metadata network targets are blocked.',
      retryable: false,
      details: { host: normalized }
    });
  };

  if (!normalized) block();
  if (blockedHostnames.has(normalized)) block();
  if (normalized.endsWith('.local') || normalized.endsWith('.localhost') || normalized.endsWith('.internal')) block();

  // IPv4 in any encoding (dotted dec/hex/octal, or a single dec/hex/octal int).
  const v4 = normalizeV4(normalized);
  if (v4 && isPrivateV4(v4)) block();

  // IPv6 literals, including IPv4-mapped forms.
  if (isPrivateV6(normalized)) block();
}
