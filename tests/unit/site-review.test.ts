import { describe, expect, it } from 'vitest';
import { deterministicPlan, normalizeSiteUrl, sameOriginPath, xmlLocs } from '../../apps/forge-edge-gateway/src/site-review';

describe('workspace-free public site review primitives', () => {
  it('normalizes public HTTP(S) targets and removes fragments', () => {
    expect(normalizeSiteUrl('https://example.com/a#section').toString()).toBe('https://example.com/a');
    expect(() => normalizeSiteUrl('http://127.0.0.1/private')).toThrow();
  });

  it('keeps discovery same-origin and strips tracking parameters', () => {
    expect(sameOriginPath('/pricing?utm_source=x&plan=pro', 'https://example.com')).toBe('/pricing?plan=pro');
    expect(sameOriginPath('https://other.example/path', 'https://example.com')).toBeNull();
    expect(sameOriginPath('javascript:alert(1)', 'https://example.com')).toBeNull();
  });

  it('parses sitemap locations without consulting robots.txt', () => {
    expect(xmlLocs('<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/docs</loc></url></urlset>'))
      .toEqual(['https://example.com/', 'https://example.com/docs']);
  });

  it('falls back to a bounded, template-diverse route sample', () => {
    const selected = deterministicPlan(['/', '/blog/a', '/blog/b', '/contact', '/docs/a', '/docs/b', '/pricing']);
    expect(selected).toEqual(['/', '/blog/a', '/contact', '/docs/a', '/pricing']);
    expect(selected.length).toBeLessThanOrEqual(6);
  });
});
