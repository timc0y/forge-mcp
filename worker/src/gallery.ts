import type { Capture } from './contracts';
import type { Env } from './env';
import { escapeHtml, page } from './ui';

/**
 * A hosted copy of a capture, and why it exists.
 *
 * Forge 1 learned this twice, in both directions. Artifact-per-screenshot
 * retrieval failed first — a non-agentic chat will not make a second call to
 * fetch evidence it already asked for — so images moved inline. But inline
 * alone is not sufficient either: MCP clients disagree about `ImageContent`,
 * and at least one passes the raw base64 to the model as text rather than
 * rendering it. Its earned invariant therefore requires both, and this is the
 * second half: images arrive with the call that asked for them AND survive at
 * one URL.
 *
 * The page is rendered once, at capture time, and stored whole. Serving is then
 * a signature check and a bucket read — no template, no database, nothing to
 * recompute, and a link that works long after the conversation ended.
 */

const CONTEXT = 'forge.gallery.v1';

async function sign(env: Env, id: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.FORGE_SIGNING_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${CONTEXT}:${id}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Length-independent comparison, so a token cannot be guessed a byte at a time. */
function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}


function render(shot: Capture, capturedAt: string): string {
  const images = shot.images
    .map(
      (image) =>
        `<figure><figcaption>${escapeHtml(image.viewport)}</figcaption>` +
        `<img alt="${escapeHtml(shot.url)} at ${escapeHtml(image.viewport)}" ` +
        `src="data:image/png;base64,${image.base64}"></figure>`
    )
    .join('');

  const notes = shot.failures
    .map((failure) => `<li>${escapeHtml(failure.viewport)}: ${escapeHtml(failure.reason)}</li>`)
    .join('');

  return (
    `<h1>${escapeHtml(shot.title || 'Capture')}</h1>` +
    `<p class="lead"><a href="${escapeHtml(shot.url)}">${escapeHtml(shot.url)}</a></p>` +
    `<div class="section alert"><p>Captured ${escapeHtml(capturedAt)}. Each image is the top of the page ` +
    `at that viewport, not the full page.</p></div>` +
    images +
    (notes ? `<div class="section"><p>Not captured:</p><ul class="list">${notes}</ul></div>` : '')
  );
}

/**
 * Store the capture and return the URL that will serve it. Best-effort by
 * design: the images are already in hand and already paid for, so a bucket
 * failure must cost the link, never the evidence.
 */
export async function storeGallery(env: Env, shot: Capture, capturedAt: string): Promise<string | null> {
  if (shot.images.length === 0) return null;
  try {
    const id = crypto.randomUUID();
    const document = await page({
      title: shot.title || 'Forge capture',
      body: render(shot, capturedAt),
      home: env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, '')
    }).text();
    await env.ARTIFACTS.put(`captures/${id}.html`, document, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' }
    });
    return `${env.FORGE_PUBLIC_ORIGIN}/see/${id}?t=${encodeURIComponent(await sign(env, id))}`;
  } catch {
    return null;
  }
}

/**
 * Serve a stored capture. A bad token and a missing object answer identically,
 * so the URL cannot be used to learn which captures exist.
 */
export async function galleryPage(env: Env, id: string, token: string): Promise<Response> {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    // Inline styles and data: images only. Nothing here loads from anywhere.
    'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
  };

  // A bad token and a missing object answer identically, and both wear the
  // same shell as everything else — a page that looks unlike the product is
  // its own kind of tell.
  const missing = page({
    status: 404,
    title: 'Forge — capture not found',
    body:
      '<h1>This capture link is not valid</h1>' +
      '<div class="section alert"><p>It may have expired, or the link may be incomplete. ' +
      'Captures are kept for 30 days.</p></div>',
    home: env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, ''),
    headers
  });

  if (!constantTimeEqual(token, await sign(env, id))) return missing;

  const object = await env.ARTIFACTS.get(`captures/${id}.html`);
  if (!object) return missing;

  return new Response(object.body, { status: 200, headers });
}
