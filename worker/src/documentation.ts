import { GFM, parser } from '@lezer/markdown';
import overview from '../../docs/README.md';
import usingForge from '../../docs/using-forge.md';
import selfHosting from '../../docs/self-hosting.md';
import operations from '../../docs/operating-forge.md';
import accountDeletion from '../../docs/account-deletion.md';
import releaseStatus from '../../docs/going-live.md';
import architecture from '../../docs/plans/context-engine.md';

const markdownParser = parser.configure(GFM);
type MarkdownNode = ReturnType<typeof markdownParser.parse>['topNode'];
const repository = 'https://github.com/timc0y/forge-mcp';
const sourceRoot = `${repository}/blob/main/`;

// These are the public pages, in reading order. Imported files remain the only copy.
export const documentationManifest = [
  { slug: 'overview', title: 'Documentation', sourcePath: 'docs/README.md', markdown: overview },
  { slug: 'using-forge', title: 'Using Forge', sourcePath: 'docs/using-forge.md', markdown: usingForge },
  { slug: 'self-hosting', title: 'Self-host Forge', sourcePath: 'docs/self-hosting.md', markdown: selfHosting },
  { slug: 'operations', title: 'Operating Forge', sourcePath: 'docs/operating-forge.md', markdown: operations },
  { slug: 'account-deletion', title: 'Account deletion', sourcePath: 'docs/account-deletion.md', markdown: accountDeletion },
  { slug: 'release-status', title: 'Release status', sourcePath: 'docs/going-live.md', markdown: releaseStatus },
  { slug: 'architecture', title: 'Context engine', sourcePath: 'docs/plans/context-engine.md', markdown: architecture }
] as const;

export interface DocumentationLink {
  slug: string;
  title: string;
  href: string;
}

export interface DocumentationHeading {
  /** Literal HTML id; href contains its percent-encoded fragment. */
  id: string;
  text: string;
  level: number;
  href: string;
}

export interface DocumentationPage {
  slug: string;
  title: string;
  bodyHTML: string;
  toc: DocumentationHeading[];
  sourceGitHubHref: string;
  previous: DocumentationLink | null;
  next: DocumentationLink | null;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
}

/** Accept the configured public origin or an already validated path mount. */
function safeHome(home: string): string {
  if (/[\s\\<>"'\u0000-\u001f\u007f]/u.test(home) || home.startsWith('//')) {
    throw new TypeError('Invalid documentation home');
  }
  const absolute = /^https?:\/\//i.test(home);
  if (!absolute && home !== '' && !home.startsWith('/')) throw new TypeError('Invalid documentation home');
  const url = new URL(home || '/', 'https://documentation.invalid');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Invalid documentation home');
  }
  const path = absolute ? home.slice(home.indexOf('/', home.indexOf('://') + 3)) : home;
  // Reject path encodings that can change the mount when decoded by another layer.
  if (/(?:^|\/)\.{1,2}(?:\/|$)|%2e|%2f|%5c|%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(path)) {
    throw new TypeError('Invalid documentation home');
  }
  return (absolute ? `${url.origin}${url.pathname}` : url.pathname).replace(/\/+$/, '');
}

function pageHref(home: string, slug: string): string {
  return `${home}/docs${slug === 'overview' ? '' : `/${encodeURIComponent(slug)}`}`;
}

export function documentationNavigation(home: string): DocumentationLink[] {
  const mount = safeHome(home);
  return documentationManifest.map(({ slug, title }) => ({ slug, title, href: pageHref(mount, slug) }));
}

function children(node: MarkdownNode): MarkdownNode[] {
  const result: MarkdownNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

function decodeEntities(text: string): string {
  // URLs must be checked after Markdown escapes and character references are decoded.
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', Tab: '\t', NewLine: '\n' };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
    if (name.startsWith('#')) {
      const hexadecimal = name[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
    }
    return named[name] ?? entity;
  });
}

function markdownText(text: string): string {
  return decodeEntities(text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1'));
}

function fragment(hash: string): string | null {
  try { return hash ? `#${encodeURIComponent(decodeURIComponent(hash.slice(1)))}` : ''; }
  catch { return null; }
}

/** Relative links refer to the Markdown file, never the current browser route. */
function linkHref(value: string, sourcePath: string, home: string): string | null {
  const raw = markdownText(value).trim();
  if (!raw || /[\u0000-\u0020\u007f\\]/u.test(raw) || raw.startsWith('//')) return null;
  if (raw.startsWith('#')) return fragment(raw);
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }
  const url = new URL(raw, `https://source.invalid/${sourcePath}`);
  let path: string;
  try { path = decodeURIComponent(url.pathname).slice(1); }
  catch { return null; }
  if (/[\\\u0000-\u001f\u007f]/u.test(path)) return null;
  const hash = fragment(url.hash);
  if (hash === null) return null;
  const hosted = documentationManifest.find(entry => entry.sourcePath === path || (path === 'docs/' && entry.slug === 'overview'));
  if (hosted) return `${pageHref(home, hosted.slug)}${url.search}${hash}`;
  // Non-hosted plans, evidence, code and directories still have a usable GitHub address.
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${repository}/${path.endsWith('/') ? 'tree' : 'blob'}/main/${encoded}${url.search}${hash}`;
}

const syntaxMarks = new Set([
  'HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'ListMark', 'QuoteMark',
  'LinkMark', 'LinkLabel', 'CodeMark', 'CodeInfo', 'TableDelimiter'
]);

/** Parse with the existing format owner. Only renderer-authored tags become HTML. */
export function renderDocumentationMarkdown(markdown: string, sourcePath: string, home: string): {
  bodyHTML: string;
  toc: DocumentationHeading[];
} {
  const mount = safeHome(home);
  const tree = markdownParser.parse(markdown);
  const toc: DocumentationHeading[] = [];
  const ids = new Set<string>();
  let tableNumber = 0;
  const references = new Map<string, { url: string; title?: string }>();
  const text = (node: MarkdownNode) => markdown.slice(node.from, node.to);
  const labelKey = (label: string) => markdownText(label).replace(/\s+/g, ' ').trim().toLowerCase();
  const cursor = tree.cursor();
  do {
    if (cursor.name !== 'LinkReference') continue;
    const parts = children(cursor.node);
    const label = parts.find(part => part.name === 'LinkLabel');
    const url = parts.find(part => part.name === 'URL');
    const title = parts.find(part => part.name === 'LinkTitle');
    if (label && url) {
      const key = labelKey(text(label).slice(1, -1));
      if (!references.has(key)) references.set(key, {
        url: text(url).replace(/^<|>$/g, ''),
        ...(title ? { title: markdownText(text(title).slice(1, -1)) } : {})
      });
    }
  } while (cursor.next());

  function content(node: MarkdownNode, from = node.from, to = node.to, plain = false): string {
    let position = from;
    let result = '';
    for (const child of children(node)) {
      if (child.from < from || child.to > to) continue;
      const gap = markdown.slice(position, child.from);
      result += plain ? gap : escape(gap);
      result += plain ? plainText(child) : render(child);
      position = child.to;
    }
    const tail = markdown.slice(position, to);
    return result + (plain ? tail : escape(tail));
  }

  function inlineCode(node: MarkdownNode): string {
    const marks = children(node).filter(child => child.name === 'CodeMark');
    const code = markdown.slice(marks[0]?.to ?? node.from, marks.at(-1)?.from ?? node.to).replace(/\r?\n/g, ' ');
    return code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code) ? code.slice(1, -1) : code;
  }

  function labelRange(node: MarkdownNode): [number, number] {
    const parts = children(node);
    const open = parts.find(part => part.name === 'LinkMark');
    const close = parts.find(part => part.name === 'LinkMark' && text(part) === ']');
    return [open?.to ?? node.from, close?.from ?? node.to];
  }

  function plainText(node: MarkdownNode): string {
    if (syntaxMarks.has(node.name)) return '';
    if (node.name === 'InlineCode') return inlineCode(node);
    if (node.name === 'Escape') return text(node).slice(1);
    if (node.name === 'Entity') return decodeEntities(text(node));
    if (node.name === 'Link' || node.name === 'Image') return content(node, ...labelRange(node), true);
    return node.firstChild ? content(node, node.from, node.to, true) : text(node);
  }

  function renderLink(node: MarkdownNode): string {
    const parts = children(node);
    const [from, to] = labelRange(node);
    const label = content(node, from, to);
    const url = parts.find(part => part.name === 'URL');
    const reference = parts.find(part => part.name === 'LinkLabel');
    const key = reference && text(reference) !== '[]' ? text(reference).slice(1, -1) : markdown.slice(from, to);
    const definition = references.get(labelKey(key));
    const title = parts.find(part => part.name === 'LinkTitle');
    const titleText = title ? markdownText(text(title).slice(1, -1)) : definition?.title;
    const href = linkHref(url ? text(url).replace(/^<|>$/g, '') : definition?.url ?? '', sourcePath, mount);
    const titleAttribute = titleText ? ` title="${escape(titleText)}"` : '';
    if (node.name === 'Image') {
      const alt = escape(content(node, from, to, true));
      return href && /^https?:\/\//i.test(href)
        ? `<img src="${escape(href)}" alt="${alt}" loading="lazy"${titleAttribute}>`
        : label;
    }
    return href ? `<a href="${escape(href)}"${titleAttribute}>${label}</a>` : label;
  }

  function render(node: MarkdownNode): string {
    const name = node.name;
    if (syntaxMarks.has(name) || name === 'LinkReference') return '';
    if (/^(?:ATX|Setext)Heading[1-6]$/.test(name)) {
      const level = Number(name.at(-1));
      const headingText = plainText(node).trim();
      const base = headingText.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
      let id = base;
      for (let suffix = 1; ids.has(id); suffix++) id = `${base}-${suffix}`;
      ids.add(id);
      toc.push({ id, text: headingText, level, href: `#${encodeURIComponent(id)}` });
      return `<h${level} id="${escape(id)}">${content(node).trim()}</h${level}>`;
    }
    switch (name) {
      case 'Document': return content(node);
      case 'Paragraph': return `<p>${content(node)}</p>`;
      case 'Emphasis': return `<em>${content(node)}</em>`;
      case 'StrongEmphasis': return `<strong>${content(node)}</strong>`;
      case 'Strikethrough': return `<del>${content(node)}</del>`;
      case 'BulletList': return `<ul>${content(node)}</ul>`;
      case 'OrderedList': {
        const first = node.firstChild?.firstChild;
        const start = first?.name === 'ListMark' ? Number.parseInt(text(first), 10) : 1;
        return `<ol${start !== 1 ? ` start="${start}"` : ''}>${content(node)}</ol>`;
      }
      case 'ListItem': return `<li>${content(node)}</li>`;
      case 'Blockquote': return `<blockquote>${content(node)}</blockquote>`;
      case 'HorizontalRule': return '<hr>';
      case 'HardBreak': return '<br>\n';
      case 'Escape': return escape(text(node).slice(1));
      case 'Entity': return text(node);
      case 'InlineCode': return `<code>${escape(inlineCode(node))}</code>`;
      case 'FencedCode':
      case 'CodeBlock': {
        const parts = children(node);
        const code = parts.filter(part => part.name === 'CodeText').map(text).join('');
        const info = parts.find(part => part.name === 'CodeInfo');
        const language = info ? text(info).trim().split(/\s/)[0] : '';
        return `<pre tabindex="0" aria-label="Code example"><code${language ? ` class="language-${escape(language)}"` : ''}>${escape(code)}</code></pre>`;
      }
      case 'Link':
      case 'Image': return renderLink(node);
      case 'Autolink': {
        const url = children(node).find(part => part.name === 'URL');
        if (!url) return escape(text(node));
        return renderAutoURL(text(url));
      }
      case 'URL': return renderAutoURL(text(node));
      case 'Table': {
        const parts = children(node);
        const header = parts.find(part => part.name === 'TableHeader');
        const rows = parts.filter(part => part.name === 'TableRow');
        return `<div class="docs-table-scroll" role="region" aria-label="${escape(toc.at(-1)?.text ?? 'Documentation')} — table ${++tableNumber}" tabindex="0"><table>${header ? `<thead>${render(header)}</thead>` : ''}<tbody>${rows.map(render).join('')}</tbody></table></div>`;
      }
      case 'TableHeader': return `<tr>${children(node).filter(part => part.name === 'TableCell').map(part => `<th scope="col">${content(part)}</th>`).join('')}</tr>`;
      case 'TableRow': return `<tr>${children(node).filter(part => part.name === 'TableCell').map(part => `<td>${content(part)}</td>`).join('')}</tr>`;
      case 'Task': return `<p>${content(node)}</p>`;
      case 'TaskMarker': return `<input type="checkbox" disabled${/x/i.test(text(node)) ? ' checked' : ''} aria-label="${/x/i.test(text(node)) ? 'Complete' : 'Incomplete'}">`;
      // Raw tags, comments and unknown syntax remain visible, inert source.
      default: return escape(text(node));
    }
  }

  function renderAutoURL(value: string): string {
    const candidate = value.startsWith('www.') ? `https://${value}` : /^[^:]+@/.test(value) ? `mailto:${value}` : value;
    const href = linkHref(candidate, sourcePath, mount);
    return href ? `<a href="${escape(href)}">${escape(value)}</a>` : escape(value);
  }

  return { bodyHTML: render(tree.topNode), toc };
}

/** No filesystem, network, account or inference work occurs while serving docs. */
export function documentationPage(home: string, slug = 'overview'): DocumentationPage | null {
  const index = documentationManifest.findIndex(entry => entry.slug === slug);
  const entry = documentationManifest[index];
  if (!entry) return null;
  const navigation = documentationNavigation(home);
  return {
    slug: entry.slug,
    title: entry.title,
    ...renderDocumentationMarkdown(entry.markdown, entry.sourcePath, home),
    sourceGitHubHref: `${sourceRoot}${entry.sourcePath}`,
    previous: navigation[index - 1] ?? null,
    next: navigation[index + 1] ?? null
  };
}
