/**
 * Forge's eyes: one public URL in, up to three viewport screenshots out.
 *
 * This calls the Browser Rendering REST API's `/snapshot` Quick Action rather
 * than the `BROWSER` binding, because Quick Actions bill browser hours only —
 * a binding-driven Puppeteer session also bills per concurrent browser. See
 * `docs/plans/forge-v1.md`'s cost section. That also means there is no
 * Durable Object or WebSocket session here: each viewport is one plain HTTP
 * POST, so "parallel" just means "concurrent fetches", not a shared browser.
 */
import type { Env } from './env';
import type { Capture, CaptureImage, Viewport } from './contracts';
import { VIEWPORT_SIZES } from './contracts';
import { ForgeError } from './errors';

/** The chat client cuts near 60s; land well inside that with room to spare. */
const CAPTURE_BUDGET_MS = 45_000;

/**
 * Give Cloudflare's own navigation timeout a few seconds' head start so a slow
 * page comes back as a clean upstream timeout message instead of us severing
 * the HTTP connection mid-response and losing whatever had already rendered.
 */
const NAVIGATION_HEADROOM_MS = 5_000;

/** A useful page outline must stay much smaller than the images beside it. */
const MAX_OUTLINE_LINES = 80;
const MAX_OUTLINE_DEPTH = 8;
const MAX_OUTLINE_LINE_CHARS = 220;

/** Roles that remain useful landmarks even when the page gives them no name. */
const OUTLINE_ROLES_WITHOUT_NAMES = new Set([
  'RootWebArea',
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'form',
  'region',
  'list',
  'table'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Cloudflare's error body, when there is one, reads better than a bare status code. */
function describeFailure(parsed: unknown, fallback: string): string {
  if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return fallback;
  const first = parsed.errors[0];
  return isRecord(first) && typeof first.message === 'string' ? first.message : fallback;
}

/**
 * Turn Cloudflare's accessibility tree into a small reading order.
 *
 * Roles and names are enough for visual review: headings, navigation, links,
 * controls and landmarks. Browser state fields and unnamed wrapper nodes are
 * deliberately omitted. The cap is disclosed to the caller rather than letting
 * a long page silently consume the rest of the chat context.
 */
export function accessibilityOutline(tree: unknown): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;

  const text = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value).replace(/\s+/g, ' ').trim()
      : '';

  const visit = (value: unknown, depth: number): void => {
    if (!isRecord(value)) return;
    if (depth > MAX_OUTLINE_DEPTH || lines.length >= MAX_OUTLINE_LINES) {
      truncated = true;
      return;
    }

    const role = text(value.role);
    const name = text(value.name);
    const nodeValue = text(value.valuetext) || text(value.value);
    const level = typeof value.level === 'number' ? ` level ${value.level}` : '';

    if (role && (name || nodeValue || OUTLINE_ROLES_WITHOUT_NAMES.has(role))) {
      const indent = '  '.repeat(Math.min(depth, 6));
      const named = name ? `: ${name}` : '';
      const valued = nodeValue && nodeValue !== name ? ` = ${nodeValue}` : '';
      lines.push(`${indent}${role}${level}${named}${valued}`.slice(0, MAX_OUTLINE_LINE_CHARS));
    }

    const children = Array.isArray(value.children) ? value.children : [];
    for (const child of children) {
      if (lines.length >= MAX_OUTLINE_LINES) {
        truncated = true;
        break;
      }
      visit(child, depth + 1);
    }
  };

  visit(tree, 0);
  return { lines, truncated };
}

/** Decoded byte size from a base64 string's length, without decoding it. */
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Browser-side redirect/resource guard. The initial URL is validated below,
 * but Chrome may later follow a redirect to a literal private destination.
 * These patterns make Browser Rendering refuse those requests too. A hostname
 * that resolves privately is a separate DNS boundary and remains something the
 * platform must refuse; arbitrary public-host capture cannot use a hostname
 * allowlist without changing the product.
 */
const BLOCKED_REQUEST_PATTERNS = [
  '^https?://localhost(?::\\d+)?(?:/|$)',
  '^https?://[^/]+\\.(?:localhost|local)(?::\\d+)?(?:/|$)',
  '^https?://(?:127(?:\\.\\d{1,3}){3}|10(?:\\.\\d{1,3}){3}|192\\.168(?:\\.\\d{1,3}){2}|169\\.254(?:\\.\\d{1,3}){2}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2})(?::\\d+)?(?:/|$)',
  '^https?://\\[(?:::1|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*)\\](?::\\d+)?(?:/|$)',
  '^https?://metadata\\.google\\.internal(?::\\d+)?(?:/|$)'
];

/**
 * True for any spelling of an IPv4 or IPv6 literal. The WHATWG URL parser
 * already folds every alternate IPv4 encoding — hex, octal, decimal integer,
 * short forms like `127.1` — into canonical dotted-decimal in `.hostname`,
 * and an IPv6 literal is always bracketed there. So one cheap check catches
 * every encoding without re-implementing a decoder.
 */
function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith('[') || IPV4_LITERAL.test(hostname);
}

/**
 * The security boundary: Forge is an HTTP client aimed at whatever URL a chat
 * supplies, so this must refuse by default rather than pattern-match known
 * bad hosts. A bare IP literal skips DNS entirely and is exactly how SSRF
 * against cloud metadata endpoints and internal services works — banning the
 * whole class subsumes every specific private range (10.x, 172.16-31.x,
 * 192.168.x, 127.x, 169.254.x, ::1, fc00::/7, fe80::/10) without maintaining a
 * blocklist that a new encoding can slip past.
 */
function assertPublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `"${rawUrl}" is not a URL Forge can capture.`
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `Only http(s) URLs can be captured, not "${url.protocol.replace(':', '')}".`
    });
  }

  // Credentials in the URL ride along to whatever Cloudflare's browser
  // fetches — a request-smuggling vector, not a page to screenshot.
  if (url.username || url.password) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'URLs with embedded credentials are not accepted.'
    });
  }

  const hostname = url.hostname.toLowerCase();
  if (isIpLiteral(hostname)) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'IP-address hosts are not accepted; use a public domain name.'
    });
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: `"${hostname}" is a local host, not a public one.`
    });
  }

  return url;
}

interface ViewportOutcome {
  viewport: Viewport;
  image?: CaptureImage;
  title?: string;
  structure?: unknown;
  reason?: string;
}

async function captureViewport(env: Env, url: URL, viewport: Viewport, remainingMs: number): Promise<ViewportOutcome> {
  const size = VIEWPORT_SIZES[viewport];
  const budget = Math.max(1_000, remainingMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/browser-rendering/snapshot`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          url: url.toString(),
          viewport: { width: size.width, height: size.height, deviceScaleFactor: 2 },
          gotoOptions: { waitUntil: 'networkidle0', timeout: Math.max(1_000, budget - NAVIGATION_HEADROOM_MS) },
          screenshotOptions: { fullPage: false },
          // /snapshot requires at least two formats; these two are the only
          // ones `Capture` has fields for, so nothing else is worth paying for.
          formats: ['screenshot', 'accessibilityTree'],
          rejectRequestPattern: BLOCKED_REQUEST_PATTERNS
        }),
        signal: controller.signal
      }
    );
    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      return { viewport, reason: describeFailure(parsed, `Capture failed (HTTP ${response.status}).`) };
    }
    if (!isRecord(parsed) || parsed.success !== true) {
      return { viewport, reason: describeFailure(parsed, 'Capture did not succeed.') };
    }

    const result = parsed.result;
    if (!isRecord(result)) {
      return { viewport, reason: 'Capture succeeded but returned no result.' };
    }

    const base64 = typeof result.screenshot === 'string' ? result.screenshot : null;
    if (!base64) {
      return { viewport, reason: 'Capture succeeded but returned no screenshot.' };
    }

    const meta = isRecord(parsed.meta) ? parsed.meta : undefined;
    const title = meta && typeof meta.title === 'string' ? meta.title : '';

    return {
      viewport,
      image: { viewport, base64, bytes: base64ByteLength(base64) },
      title,
      structure: result.accessibilityTree
    };
  } catch {
    // Cloudflare error bodies never echo the bearer token we sent, so nothing
    // caught here needs redacting — but a network/parse error message might
    // include arbitrary detail, so this stays a short fixed reason rather
    // than relaying `error.message` verbatim.
    return {
      viewport,
      reason: controller.signal.aborted
        ? 'Capture did not finish inside the time budget.'
        : 'Capture request failed.'
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function capture(env: Env, url: string, viewports: Viewport[]): Promise<Capture> {
  if (viewports.length === 0) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'At least one viewport must be requested.'
    });
  }
  if (viewports.length > 3) {
    throw new ForgeError({
      code: 'FORGE_VALIDATION_FAILED',
      message: 'At most three viewports can be captured in one call.'
    });
  }
  const requestedViewports = [...new Set(viewports)];

  const target = assertPublicUrl(url);
  const deadline = Date.now() + CAPTURE_BUDGET_MS;

  // One request per viewport, fired together: a slow phone capture must not
  // delay or sink a desktop capture that already finished.
  const outcomes = await Promise.all(
    requestedViewports.map((viewport) => captureViewport(env, target, viewport, deadline - Date.now()))
  );

  const images: CaptureImage[] = [];
  const failures: Array<{ viewport: Viewport; reason: string }> = [];
  let title = '';
  let structure: unknown;

  for (const outcome of outcomes) {
    if (outcome.image) {
      images.push(outcome.image);
      if (!title && outcome.title) title = outcome.title;
      if (structure === undefined) structure = outcome.structure;
    } else {
      failures.push({ viewport: outcome.viewport, reason: outcome.reason ?? 'Capture failed for an unknown reason.' });
    }
  }

  // Partial evidence beats none: only every viewport failing is fatal.
  if (images.length === 0) {
    throw new ForgeError({
      code: 'FORGE_UPSTREAM_UNAVAILABLE',
      message: `Every viewport failed to capture ${target.toString()}: ${failures
        .map((failure) => `${failure.viewport} (${failure.reason})`)
        .join('; ')}.`,
      retryable: true
    });
  }

  const outline = accessibilityOutline(structure);
  return {
    url: target.toString(),
    images,
    title,
    outline: outline.lines,
    outlineTruncated: outline.truncated,
    structure,
    failures
  };
}
