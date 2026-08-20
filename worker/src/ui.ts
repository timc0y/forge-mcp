/**
 * One design system for every HTML surface Forge serves.
 *
 * There are four — the landing page, the consent screen, the approval page and
 * a stored capture — and the temptation is to style each where it lives, since
 * each is only a few lines of CSS. The first Forge did exactly that and wrote
 * down what it cost: different palettes, different buttons and three different
 * Forge marks, so that someone who arrived at the front page and then approved
 * a merge saw two products. This file is that lesson, kept.
 *
 * Deliberately plain CSS in one string rather than a build step: these are
 * served from a Worker with no asset pipeline, and inlining keeps every page a
 * single request that cannot half-arrive with its stylesheet missing.
 *
 * Colours come from the reader's own light/dark setting. Nothing here hard-codes
 * a theme, and nothing loads from anywhere — no font, no script, no image — so
 * opening one of these pages tells no third party that you use Forge.
 */

/**
 * The Forge mark: an anvil, one geometric silhouette.
 *
 * Inherits `currentColor` so it reads on light or dark without a second
 * variant, and holds together down to 16px.
 */
export function forgeGlyph(size = 24): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true">` +
    '<path fill="currentColor" d="M3 21 L17 15 L54 15 L57 18 L57 24 L54 27 L38 27 L38 37 L48 37 L54 50 L10 50 L16 37 L26 37 L26 27 L17 27 Z"/>' +
    '</svg>'
  );
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string
  );
}

export const BASE_CSS = `
:root{color-scheme:light dark;--bg:#fff;--panel:#f7f7f8;--ink:#0d0d0d;--muted:#6e6e80;--line:#e5e5e5;--ring:#0d0d0d;--ok:#0f7a3d;--bad:#c02626;--ok-bg:#eaf7ef;--bad-bg:#fdeceb}
@media(prefers-color-scheme:dark){:root{--bg:#0d0d0d;--panel:#161616;--ink:#ececf1;--muted:#9a9aa6;--line:#2a2a2a;--ring:#ececf1;--ok:#4ade80;--bad:#f87171;--ok-bg:#10231a;--bad-bg:#2a1414}}
*{box-sizing:border-box}html,body{max-width:100%;overflow-x:clip}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{width:min(100% - 2.5rem,52rem);margin-inline:auto}
.skip{position:absolute;left:1rem;top:-4rem;background:var(--ink);color:var(--bg);padding:.7rem 1rem;border-radius:8px;z-index:9}.skip:focus{top:1rem}
.mark{display:inline-flex;align-items:center;gap:.6rem;font-weight:600;letter-spacing:-.01em;text-decoration:none}
.mark .box{width:32px;height:32px;border-radius:9px;border:1px solid var(--line);background:var(--panel);display:grid;place-items:center;flex:0 0 auto}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.1rem 0;border-bottom:1px solid var(--line)}
.topbar .who{display:flex;align-items:center;gap:.8rem;color:var(--muted);font-size:.9rem}
h1{margin:1.6rem 0 .6rem;font-size:clamp(1.7rem,4vw,2.4rem);line-height:1.08;letter-spacing:-.03em;text-wrap:balance;overflow-wrap:anywhere}
h2{margin:2rem 0 .6rem;font-size:1.05rem;letter-spacing:-.015em}
h3{margin:1.4rem 0 .35rem;font-size:.95rem;letter-spacing:-.01em}
p{margin:0 0 .7rem;color:var(--muted);text-wrap:pretty;overflow-wrap:anywhere}
.lead{font-size:1.1rem;color:var(--ink);margin-bottom:1.2rem}
.btn,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:.55rem 1.05rem;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;font-weight:500;text-decoration:none;cursor:pointer;transition:background 140ms ease,border-color 140ms ease}
.btn:hover,button:hover{background:var(--panel)}
.btn.primary,button.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.btn.primary:hover,button.primary:hover{opacity:.88;background:var(--ink)}
.btn:focus-visible,button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.card,.section{padding:1.25rem;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
.section{margin-bottom:1rem}
.section.plain{background:transparent;border:0;padding:0}
.section.alert{border-color:var(--ink);background:transparent}
.section.good{border-color:var(--ok);background:var(--ok-bg)}
.section.bad{border-color:var(--bad);background:var(--bad-bg)}
.section p:last-child{margin-bottom:0}
.badge{display:inline-grid;place-items:center;min-width:24px;height:24px;padding:0 .45rem;border-radius:12px;background:var(--ink);color:var(--bg);font-size:.78rem;font-weight:600;vertical-align:middle}
.note{font-size:.88rem}
.mono{font:.85rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
code{font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.code,code.block{display:block;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:.7rem .85rem;margin:.6rem 0;font:.85rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto;overflow-wrap:anywhere}
ul.list{list-style:none;margin:.6rem 0 0;padding:0}
ul.list li{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap;padding:.75rem 0;border-top:1px solid var(--line)}
ul.list li>span{display:flex;flex-direction:column;flex:1 1 12rem;min-width:0}
ul.list small{color:var(--muted);font-size:.82rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap;margin:1rem 0 0}
.kv{display:flex;gap:.75rem;align-items:baseline;padding:.35rem 0;border-bottom:1px solid var(--line)}
.kv span{flex:0 0 6.5rem;color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
.kv code{display:inline;background:none;border:0;padding:0;margin:0}
table{border-collapse:collapse;width:100%;margin:.6rem 0 0;font-size:.94rem}
th,td{text-align:left;padding:.6rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
td.gate{white-space:nowrap;color:var(--muted);font-size:.85rem}
figure{margin:0 0 1.6rem}
figcaption{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:.5rem}
figure img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:10px;display:block}
footer{border-top:1px solid var(--line);margin-top:2.5rem;padding:1.4rem 0 2.4rem;color:var(--muted);font-size:.85rem}
@media(max-width:640px){.row{flex-direction:column;align-items:stretch}.row .btn,.row button{width:100%}ul.list li>span{flex:1 1 100%}.kv{flex-direction:column;gap:.1rem}.kv span{flex:none}}
/* The surfaces we did not draw. Left at browser defaults they belong to no
   design system, and they are the cheapest tell that a page was assembled. */
::selection{background:var(--ink);color:var(--bg)}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:6px;border:3px solid var(--bg)}
::-webkit-scrollbar-thumb:hover{background:var(--muted)}
input,textarea{caret-color:var(--ink)}
a{text-underline-offset:.18em;text-decoration-thickness:1px}
li::marker{color:var(--muted)}
:root{scrollbar-color:var(--line) var(--bg);scrollbar-width:thin}

/* Hero */
.hero{padding:3.5rem 0 1rem}
.hero h1{margin:0 0 1rem;font-size:clamp(2.4rem,7vw,4.2rem);letter-spacing:-.045em;line-height:.98}
.hero .lead{font-size:clamp(1.15rem,2.4vw,1.45rem);max-width:34ch;line-height:1.35;margin-bottom:1.8rem}
.hero .lead b{font-weight:600}
.endpoint{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;border:1px solid var(--line);border-radius:12px;padding:.7rem .9rem;background:var(--panel);max-width:38rem}
.endpoint code{flex:1 1 16rem;font-size:.9rem}
.endpoint span{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}

/* Drawn icons: one library, one stroke weight. */
.ico{width:20px;height:20px;flex:0 0 auto;color:var(--ink)}
.ico.mut{color:var(--muted)}

/* The tool list: a rail, not a grid of identical cards. */
.tools{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.tools li{display:grid;grid-template-columns:20px minmax(0,10rem) minmax(0,1fr) auto;gap:.9rem;align-items:baseline;padding:.95rem .25rem;border-bottom:1px solid var(--line)}
.tools li .ico{align-self:center}
.tools b{font-weight:600;font-size:.95rem}
.tools p{margin:0;font-size:.92rem}
.tools .you{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);white-space:nowrap}
.tools .you.yes{color:var(--ink);font-weight:600}
@media(max-width:640px){.tools li{grid-template-columns:20px 1fr;row-gap:.3rem}.tools li p{grid-column:2}.tools li .you{grid-column:2}}

/* Ordered setup: the sequence is the information. */
.steps{list-style:none;counter-reset:s;margin:0;padding:0;display:grid;gap:1.5rem}
.steps li{counter-increment:s;display:grid;grid-template-columns:2.1rem 1fr;gap:1rem;align-items:start}
.steps li::before{content:counter(s);display:grid;place-items:center;width:2.1rem;height:2.1rem;border-radius:50%;background:var(--ink);color:var(--bg);font-size:.85rem;font-weight:600}
.steps h3{margin:.25rem 0 .3rem}
.steps .code{margin-top:.55rem}

/* Compact spec strip instead of a paragraph of numbers. */
.spec{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.spec div{padding:1rem 1.1rem;background:var(--bg)}
.spec b{display:block;font-size:1.35rem;letter-spacing:-.02em;margin-bottom:.15rem}
.spec span{color:var(--muted);font-size:.82rem}

/* One authored moment, from an already-visible default. */
@media(prefers-reduced-motion:no-preference){
  .rise{animation:rise .7s cubic-bezier(.16,1,.3,1) both}
  .rise:nth-of-type(2){animation-delay:.06s}
  @keyframes rise{from{opacity:0;transform:translateY(10px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`.trim();

export interface PageOptions {
  title: string;
  body: string;
  /**
   * Where the wordmark links — the mount root, so it works on a path mount.
   * Omitted on pages that do not have the origin to hand, where the mark is
   * rendered as plain branding rather than threading config through every
   * renderer to gain one link.
   */
  home?: string;
  /** Extra CSS appended after the shared sheet. */
  css?: string;
  /** Extra <head> markup — social cards and the like. */
  head?: string;
  status?: number;
  /** The front page wants indexing; a page about someone's branch does not. */
  index?: boolean;
  /** Authenticated pages must never sit in a shared cache. */
  cache?: string;
  headers?: Record<string, string>;
}

/**
 * Wrap content in the shared shell, so every surface gets the same header, mark,
 * type and dark-mode behaviour by construction rather than by remembering.
 */
export function page(options: PageOptions): Response {
  const { title, body, home, css = '', head = '', status = 200, index = false, cache = 'private,no-store' } = options;

  const mark = `<span class="box">${forgeGlyph(19)}</span>Forge`;

  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      `<title>${escapeHtml(title)}</title>` +
      `<meta name="robots" content="${index ? 'index,follow' : 'noindex,nofollow'}">` +
      // Only when the mount is known: a relative icon path resolves against the
      // current URL, which on a path mount is the wrong place.
      (home ? `<link rel="icon" href="${escapeHtml(home)}/favicon.svg">` : '') +
      head +
      `<style>${BASE_CSS}${css}</style></head>` +
      '<body><a class="skip" href="#main">Skip to content</a>' +
      `<div class="wrap"><div class="topbar">` +
      (home ? `<a class="mark" href="${escapeHtml(home)}">${mark}</a>` : `<span class="mark">${mark}</span>`) +
      '</div></div>' +
      `<main id="main" class="wrap">${body}</main>` +
      '</body></html>',
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': cache,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        // Inline styles and inline images only. Nothing here loads from a
        // network, which is what keeps these pages private to open.
        'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'",
        ...(options.headers ?? {})
      }
    }
  );
}
