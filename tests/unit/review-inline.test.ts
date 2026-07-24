import { describe, expect, it } from 'vitest';
import { normalizeViewports, selectInlineImages } from '../../apps/forge-edge-gateway/src/review-images';

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
