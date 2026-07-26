import { describe, expect, it } from 'vitest';
import { buildGalleryHtml, galleryPage, storeGallery } from '../../apps/forge-edge-gateway/src/review-gallery';
import type { Env } from '../../apps/forge-edge-gateway/src/env';

// The gallery exists because "look at the attached images" has failure modes a
// chat session cannot recover from. It is the path that has to work when
// everything cleverer has not, so it must be self-contained, shareable without a
// login, and impossible to point at someone else's screenshots.

const cell = (route: string, bytes = 100) => ({
  route,
  viewport: { id: 'phone', width: 390, height: 844 },
  state: 'entry',
  findingCount: 0,
  inline: { base64: 'A'.repeat(bytes), contentType: 'image/jpeg' }
});

function fakeEnv() {
  const stored = new Map<string, { body: string; contentType: string }>();
  const env = {
    FORGE_PUBLIC_ORIGIN: 'https://forge.test',
    FORGE_CAPABILITY_SIGNING_KEY: 'k'.repeat(48),
    ARTIFACTS: {
      async put(key: string, bytes: ArrayBuffer, options: { httpMetadata?: { contentType?: string } }) {
        stored.set(key, {
          body: new TextDecoder().decode(bytes),
          contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream'
        });
      },
      async get(key: string) {
        const hit = stored.get(key);
        return hit ? { body: hit.body, httpMetadata: { contentType: hit.contentType } } : null;
      }
    }
  };
  return { env: env as unknown as Env, stored };
}

describe('gallery page', () => {
  it('embeds every screenshot so the page needs nothing else to render', () => {
    const html = buildGalleryHtml('https://example.com', new Date().toISOString(), [cell('/'), cell('/pricing')]);
    expect(html).toContain('data:image/jpeg;base64,');
    expect((html.match(/<img /g) ?? []).length).toBe(2);
    // Nothing may be fetched at view time — no CDN, no artifact endpoint, no
    // script. A page that phones home is a page that can break later.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).toContain('noindex');
  });

  it('escapes captured values rather than trusting them', () => {
    const nasty = { ...cell('/"><script>alert(1)</script>'), state: '</figcaption>' };
    const html = buildGalleryHtml('https://example.com/"><b>', new Date().toISOString(), [nasty]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('says so when captures were too large to include', () => {
    const huge = Array.from({ length: 4 }, (_, i) => cell(`/r${i}`, 10_000_000));
    const html = buildGalleryHtml('https://example.com', new Date().toISOString(), huge);
    expect(html).toMatch(/further capture\(s\) were too large/);
  });

  it('round-trips through storage and serves the stored page', async () => {
    const { env } = fakeEnv();
    const url = await storeGallery(env, { tenantId: 'ten_a' }, 'ws_abcdefghijklmnopqrstuvwx', 'https://example.com', new Date().toISOString(), [cell('/')]);
    expect(url).toMatch(/^https:\/\/forge\.test\/gallery\/ws_[a-z0-9]+\/art_[a-z0-9]+\?t=/);

    const parsed = new URL(url!);
    const [, , workspaceId, artifactId] = parsed.pathname.split('/');
    const response = await galleryPage(new Request(url!), env, workspaceId!, artifactId!);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('data:image/jpeg;base64,');
  });

  it('refuses a link that has been edited to point somewhere else', async () => {
    const { env } = fakeEnv();
    const url = await storeGallery(env, { tenantId: 'ten_a' }, 'ws_abcdefghijklmnopqrstuvwx', 'https://example.com', new Date().toISOString(), [cell('/')]);
    const parsed = new URL(url!);
    const [, , workspaceId, artifactId] = parsed.pathname.split('/');

    // Same signed token, different workspace in the path: the token names what
    // it is good for, so swapping the path must not reach another tenant's page.
    const swapped = await galleryPage(
      new Request(`https://forge.test/gallery/ws_zzzzzzzzzzzzzzzzzzzzzzzz/${artifactId}${parsed.search}`),
      env, 'ws_zzzzzzzzzzzzzzzzzzzzzzzz', artifactId!
    );
    expect(swapped.status).toBe(404);

    // Tampered signature.
    const forged = await galleryPage(
      new Request(`${parsed.origin}${parsed.pathname}?t=abc.def`), env, workspaceId!, artifactId!
    );
    expect(forged.status).toBe(404);

    // No token at all.
    const bare = await galleryPage(new Request(`${parsed.origin}${parsed.pathname}`), env, workspaceId!, artifactId!);
    expect(bare.status).toBe(404);
  });

  it('does not write a page when nothing was captured', async () => {
    const { env, stored } = fakeEnv();
    const url = await storeGallery(env, { tenantId: 'ten_a' }, 'ws_abcdefghijklmnopqrstuvwx', 'https://example.com', new Date().toISOString(), [{ route: '/', viewport: null, state: 'entry', findingCount: 0 }]);
    expect(url).toBeUndefined();
    expect(stored.size).toBe(0);
  });

  it('never fails the review that produced the screenshots', async () => {
    const broken = {
      FORGE_PUBLIC_ORIGIN: 'https://forge.test',
      FORGE_CAPABILITY_SIGNING_KEY: 'k'.repeat(48),
      ARTIFACTS: { put: async () => { throw new Error('R2 unavailable'); } }
    } as unknown as Env;
    await expect(
      storeGallery(broken, { tenantId: 'ten_a' }, 'ws_abcdefghijklmnopqrstuvwx', 'https://example.com', new Date().toISOString(), [cell('/')])
    ).resolves.toBeUndefined();
  });
});
