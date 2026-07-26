import { describe, expect, it } from 'vitest';
import { renderDiffHtml } from '../../apps/forge-edge-gateway/src/github';

/** A unified diff for one file with `lines` changed lines. */
function fileDiff(path: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    body
  ].join('\n');
}

function countElements(html: string): number {
  return (html.match(/<(div|span|section|header|p)\b/g) ?? []).length;
}

describe('approval page diff rendering', () => {
  it('shows every changed file even when an early file is enormous', () => {
    // The bug this guards: a single overall row budget consumed in file order
    // meant one huge first file used the whole allowance and every later file
    // rendered nothing at all — not even its name. A reviewer could approve a
    // change without ever being shown that the other files existed.
    const html = renderDiffHtml([
      fileDiff('dist/bundle.js', 9_000),
      fileDiff('src/auth.ts', 5),
      fileDiff('src/billing.ts', 5)
    ].join('\n'));

    expect(html).toContain('dist/bundle.js');
    expect(html).toContain('src/auth.ts');
    expect(html).toContain('src/billing.ts');
    // The small files' contents survive too, not just their names.
    expect(html).toMatch(/src\/auth\.ts[\s\S]*line 0/);
  });

  it('caps any single file and says how much of it is hidden', () => {
    const html = renderDiffHtml(fileDiff('big.ts', 5_000));
    expect(html).toMatch(/more lines? in this file/);
    // Well under the raw line count — the point is that it is bounded.
    expect(countElements(html)).toBeLessThan(1_000);
  });

  it('spends one element per diff line, not five', () => {
    // 100 changed lines previously cost a div plus four spans each. At the old
    // shape a 4,000-line page reached ~20,000 nodes and ~660 KB of HTML, which
    // is what made the approval page slow to open.
    const html = renderDiffHtml(fileDiff('src/a.ts', 100));
    // ~100 rows + hunk row + card/header/stat elements, nowhere near 5x.
    expect(countElements(html)).toBeLessThan(130);
    expect(html).not.toContain('class="dg"');
    expect(html).toContain('data-o=');
    expect(html).toContain('data-n=');
  });

  it('keeps a large multi-file diff to a workable page size', () => {
    const diff = Array.from({ length: 40 }, (_, i) => fileDiff(`src/f${i}.ts`, 200)).join('\n');
    const html = renderDiffHtml(diff);
    // The real report was a 663 KB page for 37 files / ~7k lines.
    expect(html.length).toBeLessThan(300_000);
    expect(countElements(html)).toBeLessThan(5_000);
    // Every file still named.
    for (let i = 0; i < 40; i += 1) expect(html).toContain(`src/f${i}.ts`);
  });

  it('escapes file contents', () => {
    const html = renderDiffHtml(fileDiff('x.ts', 1).replace('+line 0', '+<script>alert(1)</script>'));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an empty diff without throwing', () => {
    expect(() => renderDiffHtml('')).not.toThrow();
  });
});
