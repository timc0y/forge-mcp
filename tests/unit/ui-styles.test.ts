import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Forge HTML surfaces', () => {
  it('bound public and authenticated layouts to narrow viewports', () => {
    const landing = readFileSync('apps/forge-edge-gateway/src/index.ts', 'utf8');
    const dashboard = readFileSync('apps/forge-edge-gateway/src/github.ts', 'utf8');
    const oauth = readFileSync('apps/forge-edge-gateway/src/oauth.ts', 'utf8');

    expect(landing).toContain('overflow-x:clip');
    expect(landing).toContain("url.pathname === '/favicon.ico'");
    // Assert the properties that keep the page usable on a phone, not the exact
    // declarations of one particular design — a redesign should be free to
    // change type and colour without tripping a layout guard.
    expect(landing).toContain('width:min(100% - 2.5rem,64rem)');
    // Cards reflow rather than being pinned to a fixed column count.
    expect(landing).toMatch(/grid-template-columns:repeat\(auto-fit,minmax\(min\(100%/);
    // Actions stack instead of overflowing on a narrow screen.
    expect(landing).toMatch(/@media\(max-width:640px\)\{[^}]*flex-direction:column/);
    // Each numbered step must present exactly two grid children: the counter,
    // and one wrapper holding everything else. A loose text node beside the <b>
    // becomes a third item and lands in the 1.9rem counter column, which wraps
    // the whole description one word per line.
    const steps = landing.slice(landing.indexOf('<section class="steps">'), landing.indexOf('</ol>'));
    const items = steps.match(/<li>.*?<\/li>/gs) ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item, item.slice(0, 60)).toMatch(/^<li><span>.*<\/span><\/li>$/s);
    }
    // The authenticated surfaces share one stylesheet now, so the guards move
    // with them: the shell bounds its own width, grid children may shrink below
    // their content, and long unbroken strings (ids, refs, URLs) wrap.
    const ui = readFileSync('apps/forge-edge-gateway/src/ui.ts', 'utf8');
    expect(ui).toContain('overflow-x:clip');
    expect(ui).toContain('width:min(100% - 2.5rem,64rem)');
    expect(ui).toContain('overflow-wrap:anywhere');
    expect(dashboard).toContain('.grid>*{min-width:0}');
    // The portal's two columns collapse rather than squeezing on a phone.
    expect(dashboard).toMatch(/@media\(max-width:820px\)\{\.grid\{grid-template-columns:1fr/);
    // Every authenticated surface goes through the shared shell, so none of them
    // can drift back to its own palette, mark or button without this failing.
    for (const [name, source] of [['portal/approval', dashboard], ['oauth', oauth], ['gallery', readFileSync('apps/forge-edge-gateway/src/review-gallery.ts', 'utf8')]] as const) {
      expect(source, name).toMatch(/from '\.\/ui'/);
    }
    // One mark everywhere: no surface may define its own.
    for (const file of ['index.ts', 'github.ts', 'oauth.ts', 'review-gallery.ts']) {
      const source = readFileSync(`apps/forge-edge-gateway/src/${file}`, 'utf8');
      expect(source.includes('export function forgeGlyph'), file).toBe(false);
    }
    // And none of them may reintroduce a bespoke accent colour.
    for (const file of ['github.ts', 'oauth.ts', 'review-gallery.ts']) {
      const source = readFileSync(`apps/forge-edge-gateway/src/${file}`, 'utf8');
      expect(/#5b4cf0|#23784b|#a78bfa/.test(source), file).toBe(false);
    }
  });
});
