import { readFileSync } from 'node:fs';
import { GFM, parser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import {
  documentationManifest,
  documentationNavigation,
  documentationPage,
  renderDocumentationMarkdown
} from '../src/documentation';

const home = 'https://example.com/forge';
const render = (markdown: string, mount = home) => renderDocumentationMarkdown(markdown, 'docs/using-forge.md', mount);

describe('public documentation sources and routes', () => {
  it('imports each complete current Markdown source, including the final content', () => {
    expect(documentationManifest).toHaveLength(7);
    for (const entry of documentationManifest) {
      const original = readFileSync(new URL(`../../${entry.sourcePath}`, import.meta.url), 'utf8');
      expect(entry.markdown, entry.sourcePath).toBe(original);
      const page = documentationPage(home, entry.slug)!;
      expect(page.bodyHTML.length, entry.sourcePath).toBeGreaterThan(original.length * 0.8);
      expect(page.bodyHTML, entry.sourcePath).toMatch(/<h1 id="[^"]+">/);
      expect(page.sourceGitHubHref).toBe(`https://github.com/timc0y/forge-mcp/blob/main/${entry.sourcePath}`);
    }
  });

  it('keeps complete large content instead of hiding long sections', () => {
    const paragraphs = Array.from({ length: 600 }, (_, index) => `Paragraph ${index}: literal source with <unsafe-${index}> & text.`);
    const markdown = `# Full document\n\n${paragraphs.join('\n\n')}\n\n## Final section\n\nLast paragraph is retained.\n`;
    const result = render(markdown);
    for (let index = 0; index < paragraphs.length; index++) {
      expect(result.bodyHTML).toContain(`Paragraph ${index}: literal source with &lt;unsafe-${index}&gt; &amp; text.`);
    }
    expect(result.bodyHTML).toContain('<h2 id="final-section">Final section</h2>');
    expect(result.bodyHTML).toContain('<p>Last paragraph is retained.</p>');
  });

  it('retains every prose segment and code span in every current public source', () => {
    const escapeText = (value: string) => value.replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]!);
    const containers = /^(?:Paragraph|ATXHeading[1-6]|SetextHeading[1-6]|StrongEmphasis|Emphasis|Strikethrough|TableCell|Task|Link|Image)$/;
    for (const entry of documentationManifest) {
      const original = readFileSync(new URL(`../../${entry.sourcePath}`, import.meta.url), 'utf8');
      const html = documentationPage(home, entry.slug)!.bodyHTML;
      const cursor = parser.configure(GFM).parse(original).cursor();
      do {
        const node = cursor.node;
        if (node.name === 'CodeText') expect(html, entry.sourcePath).toContain(escapeText(original.slice(node.from, node.to)));
        if (!containers.test(node.name)) continue;
        let offset = node.from;
        for (let child = node.firstChild; child; child = child.nextSibling) {
          const prose = original.slice(offset, child.from).trim();
          if (prose) expect(html, `${entry.sourcePath}: ${prose}`).toContain(escapeText(prose));
          offset = child.to;
        }
        const prose = original.slice(offset, node.to).trim();
        if (prose) expect(html, `${entry.sourcePath}: ${prose}`).toContain(escapeText(prose));
      } while (cursor.next());
    }
  });

  it('returns meaningful navigation and null for unknown slugs', () => {
    const navigation = documentationNavigation(home);
    expect(navigation[0]).toEqual({ slug: 'overview', title: 'Documentation', href: `${home}/docs` });
    expect(documentationPage(home)?.previous).toBeNull();
    expect(documentationPage(home)?.next).toEqual(navigation[1]);
    expect(documentationPage(home, 'operations')?.previous).toEqual(navigation[2]);
    expect(documentationPage(home, 'architecture')?.next).toBeNull();
    for (const slug of ['missing', '../operations', 'Operations', 'toString', '']) expect(documentationPage(home, slug)).toBeNull();
  });

  it.each(['https://example.com/forge', 'https://example.com/forge/', 'http://localhost:8787/forge', '/forge', '/forge/', '/', ''])('uses safe origin or mount %s', mount => {
    const prefix = mount.replace(/\/+$/, '');
    expect(documentationNavigation(mount)[0]?.href).toBe(`${prefix}/docs`);
    expect(render('[Operations](./operating-forge.md)', mount).bodyHTML).toContain(`href="${prefix}/docs/operations"`);
  });

  it.each(['//evil.test/forge', 'javascript:alert(1)', 'forge', '/a/../forge', '/a/%2e%2e/forge', '/a%2fforge', '/a\\forge', '/a?x=1', '/a#part', 'https://user:pass@example.com/forge', 'https://example.com/forge?x=1', 'https://example.com/forge#part', '/a\nb', '/a"b'])('rejects unsafe home %j', mount => {
    expect(() => documentationNavigation(mount)).toThrow(TypeError);
  });
});

describe('format-owner Markdown rendering', () => {
  it('renders headings, inline formatting, lists, quotes, tasks, rules and hard breaks', () => {
    const result = render('# Title\n\nSetext heading\n--------------\n\nText *em* **strong** ~~removed~~ `a < b` \\*literal\\*.  \nNew line.\n\n> Quoted **content**\n\n- First\n  - Nested\n- Second\n\n3. Three\n4. Four\n\n- [ ] Pending\n- [x] Complete\n\n---');
    expect(result.bodyHTML).toContain('<h1 id="title">Title</h1>');
    expect(result.bodyHTML).toContain('<h2 id="setext-heading">Setext heading</h2>');
    expect(result.bodyHTML).toContain('<em>em</em> <strong>strong</strong> <del>removed</del> <code>a &lt; b</code> *literal*.');
    expect(result.bodyHTML).toContain('<br>');
    expect(result.bodyHTML).toContain('<blockquote>');
    expect(result.bodyHTML.match(/<ul>/g)).toHaveLength(3);
    expect(result.bodyHTML).toContain('<ol start="3">');
    expect(result.bodyHTML).toContain('type="checkbox" disabled aria-label="Incomplete"');
    expect(result.bodyHTML).toContain('type="checkbox" disabled checked aria-label="Complete"');
    expect(result.bodyHTML).toContain('<hr>');
  });

  it('keeps fenced and indented code literal, including nested code and blank lines', () => {
    const result = render('```html\n<script>alert("x")</script>\n\n& < >\n```\n\n    first\n    second\n\n> ```js\n> one\n> two\n> ```');
    expect(result.bodyHTML).toContain('<pre tabindex="0" aria-label="Code example"><code class="language-html">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\n\n&amp; &lt; &gt;</code></pre>');
    expect(result.bodyHTML).toContain('<pre tabindex="0" aria-label="Code example"><code>first\nsecond</code></pre>');
    expect(result.bodyHTML).toContain('<pre tabindex="0" aria-label="Code example"><code class="language-js">one\ntwo</code></pre>');
    expect(result.bodyHTML).not.toContain('<script>');
  });

  it('renders actual tables with a mobile scroll wrapper and semantic headers', () => {
    const result = render('| Setting | Value |\n| :--- | ---: |\n| `FORGE_PUBLIC_ORIGIN` | **public** |\n| link | [using](./using-forge.md) |');
    expect(result.bodyHTML).toContain('<div class="docs-table-scroll" role="region" aria-label="Documentation — table 1" tabindex="0"><table><thead><tr><th scope="col">Setting</th><th scope="col">Value</th></tr></thead><tbody>');
    expect(result.bodyHTML).toContain('<td><code>FORGE_PUBLIC_ORIGIN</code></td><td><strong>public</strong></td>');
    expect(result.bodyHTML).toContain(`<a href="${home}/docs/using-forge">using</a>`);
  });

  it('produces stable, unique Unicode heading ids and encoded heading links', () => {
    const markdown = '# Héllo 世界 &amp; `code`! ###\n\n## Same\n\n## Same\n\n## Same-1\n\n## Same';
    const result = render(markdown);
    expect(result.toc).toEqual([
      { id: 'héllo-世界--code', text: 'Héllo 世界 & code!', level: 1, href: '#h%C3%A9llo-%E4%B8%96%E7%95%8C--code' },
      { id: 'same', text: 'Same', level: 2, href: '#same' },
      { id: 'same-1', text: 'Same', level: 2, href: '#same-1' },
      { id: 'same-1-1', text: 'Same-1', level: 2, href: '#same-1-1' },
      { id: 'same-2', text: 'Same', level: 2, href: '#same-2' }
    ]);
    expect(render(markdown).toc).toEqual(result.toc);
    for (const heading of result.toc) expect(result.bodyHTML).toContain(`id="${heading.id}"`);
  });

  it('rewrites hosted relative links and sends remaining source links to GitHub', () => {
    const result = render('[release](./going-live.md#compatibility-and-release-checklist--23-october-2026) [architecture](./plans/context-engine.md#13-evaluation-prove-efficiency-not-just-compression) [overview](./README.md) [directory](./research/) [history](./research/forge-history-tool-learnings.md#notes) [root](../README.md#forge) [code](../worker/src/privacy.ts#L12) [space](./some%20file.md) [same](#The%20heading)');
    expect(result.bodyHTML).toContain(`href="${home}/docs/release-status#compatibility-and-release-checklist--23-october-2026"`);
    expect(result.bodyHTML).toContain(`href="${home}/docs/architecture#13-evaluation-prove-efficiency-not-just-compression"`);
    expect(result.bodyHTML).toContain(`href="${home}/docs"`);
    expect(result.bodyHTML).toContain('href="https://github.com/timc0y/forge-mcp/tree/main/docs/research/"');
    expect(result.bodyHTML).toContain('href="https://github.com/timc0y/forge-mcp/blob/main/docs/research/forge-history-tool-learnings.md#notes"');
    expect(result.bodyHTML).toContain('href="https://github.com/timc0y/forge-mcp/blob/main/README.md#forge"');
    expect(result.bodyHTML).toContain('href="https://github.com/timc0y/forge-mcp/blob/main/worker/src/privacy.ts#L12"');
    expect(result.bodyHTML).toContain('href="https://github.com/timc0y/forge-mcp/blob/main/docs/some%20file.md"');
    expect(result.bodyHTML).toContain('href="#The%20heading"');
  });

  it('supports reference links, titles, images, autolinks and literal entities', () => {
    const result = render('[Named][release] [release][] [release] ![Safe *alt*](https://example.com/i.png "A &quot;title&quot;")\n\n<https://example.com/a?b=1&c=2> www.example.com hello@example.com\n\n&amp; &#60; &copy;\n\n[release]: ./going-live.md "Release status"');
    expect(result.bodyHTML.match(new RegExp(`href="${home}/docs/release-status" title="Release status"`, 'g'))).toHaveLength(3);
    expect(result.bodyHTML).toContain('alt="Safe alt" loading="lazy" title="A &quot;title&quot;"');
    expect(result.bodyHTML).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(result.bodyHTML).toContain('href="https://www.example.com/"');
    expect(result.bodyHTML).toContain('href="mailto:hello@example.com"');
    expect(result.bodyHTML).toContain('&amp; &#60; &copy;');
    expect(result.bodyHTML).not.toContain('[release]:');
  });

  it('escapes raw HTML and rejects executable or credential-bearing URLs', () => {
    const result = render('<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>\n\nText <b onclick="bad()">raw</b> & unescaped.\n\n[bad](javascript:alert) [entity](javascript&colon;alert) [numeric](java&#x73;cript:alert) [data](data:text/html,bad) [file](file:///tmp/a) [protocol](//evil.test/a) [credentials](https://user:pass@example.com/) ![bad-image](javascript:bad) ![data-image](data:image/svg+xml,bad)\n\n```\n<a href="javascript:bad">code</a>\n```');
    expect(result.bodyHTML).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(result.bodyHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(result.bodyHTML).toContain('&lt;b onclick=&quot;bad()&quot;&gt;raw&lt;/b&gt;');
    expect(result.bodyHTML).not.toMatch(/<(?:script|img|b)(?:\s|>)/);
    expect(result.bodyHTML).not.toContain('<a href=');
    expect(result.bodyHTML).toContain('bad-image');
    expect(result.bodyHTML).toContain('data-image');
  });

  it('preserves release and cost caveats, privacy SQL and final source sections', () => {
    expect(documentationPage(home, 'using-forge')?.bodyHTML).toContain('your configured instance URL');
    expect(documentationPage(home, 'release-status')?.bodyHTML).toContain('Before inviting others');
    expect(documentationPage(home, 'self-hosting')?.bodyHTML).toContain('Local development');
    expect(documentationPage(home, 'operations')?.bodyHTML).toContain('Things that will bite');
    expect(documentationPage(home, 'account-deletion')?.bodyHTML).toContain('DELETE FROM captures WHERE user_id = &#39;FORGE_USER_ID&#39;;');
    expect(documentationPage(home, 'architecture')?.bodyHTML).toContain('Final design rule');
  });
});
