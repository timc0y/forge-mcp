import { ids, type ArtifactId, type TenantId, type WorkspaceId } from '@forge/core';
import { R2ArtifactStore } from '@forge/artifacts-r2';
import type { Env } from './env';
import { BASE_CSS, forgeGlyph } from './ui';

/**
 * A shareable page of the screenshots from one review.
 *
 * The screenshots come back attached to the tool result, which is the fast path.
 * But that path depends on the client rendering image content in a tool
 * response, keeping it in context, and showing it to the human — and an ordinary
 * chat session does not reliably do all three, especially once a conversation
 * gets long or a grid is too big to return at once. When the pictures are the
 * entire point, "look at the attached images" needs a fallback that cannot fail.
 *
 * So every review also writes a self-contained HTML page — screenshots embedded
 * as data URIs, no external requests, nothing to fetch — and returns one URL. A
 * model that can do nothing else can still hand over a link, and the human opens
 * it in a browser. No polling, no second tool call, no client-specific rendering
 * behaviour to depend on.
 */

// Bounds on the stored page. Generous compared to what a tool result can carry —
// this is the copy that is meant to hold everything — but still finite so a
// 20-cell full-page review cannot write an unbounded object.
const MAX_GALLERY_IMAGES = 24;
const MAX_GALLERY_BYTES = 24_000_000;
const GALLERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface GalleryCell {
  route: unknown;
  viewport: unknown;
  state: unknown;
  findingCount: number;
  inline?: { base64: string; contentType: string };
}

interface GalleryClaims {
  tenant: string;
  workspace: string;
  artifact: string;
  exp: number;
}

function base64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signGalleryLink(env: Env, claims: GalleryClaims): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(env.FORGE_CAPABILITY_SIGNING_KEY), new TextEncoder().encode(payload));
  return `${payload}.${base64Url(signature)}`;
}

async function verifyGalleryLink(env: Env, token: string): Promise<GalleryClaims | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  let signature: ArrayBuffer;
  try {
    signature = base64UrlDecode(token.slice(dot + 1));
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(env.FORGE_CAPABILITY_SIGNING_KEY), signature, new TextEncoder().encode(payload));
  if (!valid) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as GalleryClaims;
    return claims.exp > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string
  );
}

function viewportLabel(viewport: unknown): string {
  if (viewport && typeof viewport === 'object') {
    const value = viewport as { id?: unknown; width?: unknown; height?: unknown };
    if (value.width && value.height) return `${String(value.id ?? 'viewport')} · ${String(value.width)}×${String(value.height)}`;
    if (value.id) return String(value.id);
  }
  return String(viewport ?? 'viewport');
}

/** Render the review as one standalone page with every image embedded. */
export function buildGalleryHtml(sourceUrl: string, capturedAt: string, cells: GalleryCell[]): string {
  const withImages = cells.filter((cell) => cell.inline);
  const included: GalleryCell[] = [];
  let bytes = 0;
  for (const cell of withImages) {
    const size = cell.inline!.base64.length;
    if (included.length >= MAX_GALLERY_IMAGES || bytes + size > MAX_GALLERY_BYTES) break;
    included.push(cell);
    bytes += size;
  }
  const omitted = withImages.length - included.length;
  const figures = included.map((cell) => `<figure>
<figcaption><strong>${escapeHtml(cell.route)}</strong><span>${escapeHtml(viewportLabel(cell.viewport))}${cell.state ? ` · ${escapeHtml(cell.state)}` : ''}${cell.findingCount > 0 ? ` · ${cell.findingCount} finding(s)` : ''}</span></figcaption>
<img loading="lazy" alt="${escapeHtml(cell.route)} at ${escapeHtml(viewportLabel(cell.viewport))}" src="data:${escapeHtml(cell.inline!.contentType)};base64,${cell.inline!.base64}">
</figure>`).join('\n');
  const note = omitted > 0
    ? `<p class="note">${omitted} further capture(s) were too large to include on this page.</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><link rel="icon" href="/favicon.ico">
<title>Forge screenshots — ${escapeHtml(sourceUrl)}</title>
<style>${BASE_CSS}
.head{padding:1.6rem 0 .6rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:1.25rem;margin-top:1.6rem}
figure{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
figcaption{display:flex;flex-direction:column;gap:2px;padding:.7rem .9rem;border-bottom:1px solid var(--line)}
figcaption strong{font:600 .85rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
figcaption span{color:var(--muted);font-size:.78rem}
img{display:block;width:100%;height:auto;background:var(--bg)}
.wrap{width:min(100% - 2.5rem,76rem)}</style></head>
<body><div class="wrap"><div class="topbar"><span class="mark"><span class="box">${forgeGlyph(19)}</span>Forge</span>
<div class="who">${included.length} screenshot(s)</div></div></div>
<main class="wrap"><div class="head"><h1>${escapeHtml(sourceUrl)}</h1>
<p>Captured ${escapeHtml(capturedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'))}.</p>${note}</div>
<div class="grid">${figures}</div>
<footer>Self-contained — the images are embedded, nothing is fetched from anywhere else.</footer></main></body></html>`;
}

/**
 * Store the gallery and return a signed, expiring URL for it. Best-effort by
 * contract: a review that captured screenshots must still succeed even if the
 * page cannot be written, because the attached images remain the primary path.
 */
export async function storeGallery(
  env: Env,
  identity: { tenantId: string },
  workspaceId: string,
  sourceUrl: string,
  capturedAt: string,
  cells: GalleryCell[]
): Promise<string | undefined> {
  if (!cells.some((cell) => cell.inline)) return undefined;
  try {
    const html = buildGalleryHtml(sourceUrl, capturedAt, cells);
    const artifactId = ids.artifact();
    await new R2ArtifactStore(env.ARTIFACTS).put({
      id: artifactId as ArtifactId,
      tenantId: identity.tenantId as TenantId,
      workspaceId: workspaceId as WorkspaceId,
      bytes: new TextEncoder().encode(html).buffer as ArrayBuffer,
      kind: 'review-gallery',
      contentType: 'text/html; charset=utf-8',
      metadata: { sourceUrl, capturedAt }
    });
    const token = await signGalleryLink(env, {
      tenant: identity.tenantId,
      workspace: workspaceId,
      artifact: artifactId,
      exp: Date.now() + GALLERY_TTL_MS
    });
    return `${env.FORGE_PUBLIC_ORIGIN}/gallery/${workspaceId}/${artifactId}?t=${encodeURIComponent(token)}`;
  } catch (error) {
    console.error('forge_review_gallery_store_failed', {
      workspaceId,
      name: error instanceof Error ? error.name : 'unknown'
    });
    return undefined;
  }
}

/**
 * Serve a stored gallery. Authorized purely by the signed token, which names the
 * exact tenant, workspace and artifact it is good for and expires — so a link
 * can be pasted into a chat and opened by the person it was meant for, without
 * them having to log in first, and cannot be edited to reach anything else.
 */
export async function galleryPage(
  request: Request,
  env: Env,
  workspaceId: string,
  artifactId: string
): Promise<Response> {
  const token = new URL(request.url).searchParams.get('t') ?? '';
  const claims = token ? await verifyGalleryLink(env, token) : null;
  if (!claims || claims.workspace !== workspaceId || claims.artifact !== artifactId) {
    return new Response('This screenshot link is invalid or has expired.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }
  const stored = await new R2ArtifactStore(env.ARTIFACTS).get(
    claims.tenant as TenantId,
    workspaceId as WorkspaceId,
    artifactId as ArtifactId
  );
  if (!stored) return new Response('These screenshots are no longer stored.', { status: 404 });
  return new Response(stored.body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private,no-store',
      'x-robots-tag': 'noindex,nofollow,noarchive',
      'referrer-policy': 'no-referrer',
      // The page embeds its own images and loads nothing else; say so.
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    }
  });
}
