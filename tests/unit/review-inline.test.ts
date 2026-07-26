import { describe, expect, it } from 'vitest';
import { normalizeViewports, prepareInlineImages, selectInlineImages } from '../../apps/forge-edge-gateway/src/review-images';

// Screenshots are the deliverable of forge_review, and the main client for it is
// an ordinary chat session that will not reliably chain a second tool call to go
// and fetch them. So what comes back attached to the first result, and how much
// scaffolding the caller had to build to ask for it, is the whole product.

describe('viewport shorthand', () => {
  it('accepts the names a chat model will actually write', () => {
    expect(normalizeViewports(['phone'])).toEqual([{ id: 'phone', width: 390, height: 844 }]);
    expect(normalizeViewports(['phone', 'desktop']).map((v) => v.id)).toEqual(['phone', 'desktop']);
    expect(normalizeViewports(['tablet'])[0]).toMatchObject({ width: 820, height: 1180 });
  });

  it('still accepts explicit sizes, and a mix of both', () => {
    const custom = { id: 'wide', width: 1920, height: 1080 };
    expect(normalizeViewports([custom])).toEqual([custom]);
    expect(normalizeViewports(['phone', custom]).map((v) => v.id)).toEqual(['phone', 'wide']);
  });

  it('falls back to phone + desktop rather than capturing nothing', () => {
    // A model that sends junk, an empty array, or omits the field entirely should
    // still get screenshots back — an empty viewport list would capture zero
    // cells and read as "your site is fine".
    for (const input of [undefined, null, [], ['nonsense'], 'phone', [{ id: 'broken' }]]) {
      expect(normalizeViewports(input).map((v) => v.id), JSON.stringify(input)).toEqual(['phone', 'desktop']);
    }
  });
});

describe('choosing which screenshots travel inline', () => {
  const img = (bytes: number) => ({ base64: 'x'.repeat(bytes), contentType: 'image/jpeg' });
  const cell = (route: string, bytes = 1000) => ({ route, inline: img(bytes) });

  it('covers every route before doubling up on any one of them', () => {
    // Three routes at two viewports, but only four images fit. All three routes
    // once each beats two routes twice — the caller asked about three pages.
    const cells = [
      cell('/'), cell('/'), cell('/pricing'), cell('/pricing'), cell('/about'), cell('/about')
    ];
    const { chosen } = selectInlineImages(cells);
    const routes = new Set(chosen.slice(0, 3).map((c) => c.route));
    expect(routes).toEqual(new Set(['/', '/pricing', '/about']));
  });

  it('stops on the byte budget, not just the count', () => {
    // One full-page desktop capture can outweigh several phone shots, so a flat
    // count would either starve the cheap case or blow the payload on this one.
    const huge = Array.from({ length: 8 }, (_, i) => cell(`/r${i}`, 2_000_000));
    const { chosen, omitted } = selectInlineImages(huge);
    const total = chosen.reduce((sum, c) => sum + c.inline.base64.length, 0);
    expect(total).toBeLessThanOrEqual(3_500_000);
    expect(chosen.length).toBeLessThan(huge.length);
    expect(omitted).toBe(huge.length - chosen.length);
  });

  it('never silently drops captures from the count', () => {
    const cells = Array.from({ length: 20 }, (_, i) => cell(`/r${i}`, 100));
    const { chosen, omitted } = selectInlineImages(cells);
    // Whatever the caps do, chosen + omitted must account for every image, or
    // the caller is told it saw everything when it did not.
    expect(chosen.length + omitted).toBe(cells.length);
    expect(chosen.length).toBeLessThanOrEqual(8);
  });

  it('ignores cells that produced no image at all', () => {
    const cells = [cell('/'), { route: '/broken' }, cell('/pricing')];
    const { chosen, omitted } = selectInlineImages(cells);
    expect(chosen).toHaveLength(2);
    expect(omitted).toBe(0);
  });

  it('returns nothing to attach when nothing was captured', () => {
    expect(selectInlineImages([])).toEqual({ chosen: [], omitted: 0 });
  });
});

describe('downscaling attached copies (Cloudflare Images)', () => {
  const big = 'B'.repeat(600_000);
  const small = 'S'.repeat(1000);
  const cellOf = (route: string, base64: string) => ({ route, inline: { base64, contentType: 'image/png' } });

  function imagesEnv(shrunkTo = 'T'.repeat(5000)) {
    const calls: Array<{ width?: number }> = [];
    const env = {
      IMAGES: {
        input: () => ({
          transform: (options: { width?: number }) => {
            calls.push(options);
            return {
              output: async () => ({
                image: () => new Response(shrunkTo).body!,
                contentType: () => 'image/jpeg'
              })
            };
          }
        })
      }
    };
    return { env, calls };
  }

  it('never transforms an image that is already small enough', async () => {
    // Transformations are billed per image, and most phone captures are already
    // inside the target — paying to shrink them would be money for nothing.
    const { env, calls } = imagesEnv();
    const { chosen } = await prepareInlineImages(env, [cellOf('/', small), cellOf('/a', small)]);
    expect(calls).toHaveLength(0);
    expect(chosen.every((c) => c.inline.base64 === small)).toBe(true);
  });

  it('only pays for images that could actually be attached', async () => {
    // 20 oversized captures, but at most 8 can ever be attached — the other 12
    // must not each cost a transformation to then be discarded.
    const { env, calls } = imagesEnv();
    const cells = Array.from({ length: 20 }, (_, i) => cellOf(`/r${i}`, big));
    await prepareInlineImages(env, cells);
    expect(calls.length).toBeLessThanOrEqual(8);
  });

  it('shrinks oversized copies so more of them fit', async () => {
    const { env, calls } = imagesEnv();
    const cells = Array.from({ length: 8 }, (_, i) => cellOf(`/r${i}`, big));
    // Unshrunk, the byte budget admits far fewer than eight of these.
    const withoutImages = await prepareInlineImages(undefined, cells);
    const withImages = await prepareInlineImages(env, cells);
    expect(calls.length).toBeGreaterThan(0);
    expect(withImages.chosen.length).toBeGreaterThan(withoutImages.chosen.length);
    expect(withImages.chosen[0]!.inline.contentType).toBe('image/jpeg');
  });

  it('keeps the original when the transform came back no smaller', async () => {
    const { env } = imagesEnv('X'.repeat(900_000));
    const { chosen } = await prepareInlineImages(env, [cellOf('/', big)]);
    expect(chosen[0]!.inline.base64).toBe(big);
  });

  it('falls back to the original bytes when Images is unavailable or fails', async () => {
    // A missing binding, and a binding that throws, must both behave exactly as
    // before — a review that captured screenshots must never fail over this.
    const broken = { IMAGES: { input: () => { throw new Error('quota exceeded'); } } };
    for (const env of [undefined, {}, broken]) {
      const { chosen, omitted } = await prepareInlineImages(env, [cellOf('/', small)]);
      expect(chosen).toHaveLength(1);
      expect(chosen[0]!.inline.base64).toBe(small);
      expect(omitted).toBe(0);
    }
  });

  it('still accounts for every captured image', async () => {
    const { env } = imagesEnv();
    const cells = Array.from({ length: 30 }, (_, i) => cellOf(`/r${i}`, big));
    const { chosen, omitted } = await prepareInlineImages(env, cells);
    expect(chosen.length + omitted).toBe(cells.length);
  });
});
