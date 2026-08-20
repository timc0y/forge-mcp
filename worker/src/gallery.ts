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
const CAPTURE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
export async function storeGallery(
  env: Env,
  shot: Capture,
  capturedAt: string,
  userId: string
): Promise<string | null> {
  if (shot.images.length === 0) return null;

  const id = crypto.randomUUID();
  const objectKey = `captures/${id}.html`;
  const capturedMs = Date.parse(capturedAt);
  const createdAt = Number.isNaN(capturedMs) ? new Date() : new Date(capturedMs);
  const expiresAt = new Date(createdAt.getTime() + CAPTURE_TTL_MS);

  try {
    const document = await page({
      title: shot.title || 'Forge capture',
      body: render(shot, createdAt.toISOString()),
      home: env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, '')
    }).text();
    await env.ARTIFACTS.put(objectKey, document, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' }
    });
  } catch {
    return null;
  }

  try {
    await env.METADATA.prepare(
      `INSERT INTO captures (id, user_id, object_key, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(id, userId, objectKey, createdAt.toISOString(), expiresAt.toISOString())
      .run();
  } catch {
    // An unowned object cannot be honoured in an account-deletion request.
    // Remove it rather than returning a link Forge can no longer account for.
    await env.ARTIFACTS.delete(objectKey).catch(() => undefined);
    return null;
  }

  try {
    return `${env.FORGE_PUBLIC_ORIGIN}/see/${id}?t=${encodeURIComponent(await sign(env, id))}`;
  } catch {
    // Storage is only useful when Forge can return a working bearer link. Keep
    // the tool's evidence-inline guarantee and remove the unreachable copy.
    await Promise.allSettled([
      env.ARTIFACTS.delete(objectKey),
      env.METADATA.prepare('DELETE FROM captures WHERE id = ?1').bind(id).run()
    ]);
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

  // Rows exist for captures made after migration 0002. A missing row is treated
  // as a legacy capture and left to the bucket lifecycle, so the migration does
  // not break links minted before ownership was recorded. A failed D1 read is
  // not treated as a missing row: retention and deletion controls fail closed.
  const row = await env.METADATA.prepare(
    'SELECT object_key, expires_at FROM captures WHERE id = ?1'
  )
    .bind(id)
    .first<{ object_key: string; expires_at: string }>();

  const objectKey = row?.object_key ?? `captures/${id}.html`;
  const expiresMs = row ? Date.parse(row.expires_at) : Number.POSITIVE_INFINITY;
  if (row && (!Number.isFinite(expiresMs) || expiresMs <= Date.now())) {
    await Promise.allSettled([
      env.ARTIFACTS.delete(objectKey),
      env.METADATA.prepare('DELETE FROM captures WHERE id = ?1').bind(id).run()
    ]);
    return missing;
  }

  const object = await env.ARTIFACTS.get(objectKey);
  if (!object) {
    if (row) {
      await env.METADATA.prepare('DELETE FROM captures WHERE id = ?1').bind(id).run().catch(() => undefined);
    }
    return missing;
  }

  return new Response(object.body, { status: 200, headers });
}
