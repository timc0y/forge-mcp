import { documentationNavigation, documentationPage } from './documentation';
import { escapeHtml as esc, page, type PageOptions } from './ui';

export const arrow = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const repository = 'https://github.com/timc0y/forge-mcp';
const operatorContact = 'https://timcoy.uk/';

export function publicFooter(home: string): string {
  return `<footer class="site-footer"><a class="footer-line" href="${esc(home)}">Useful work belongs in your project.</a><div><span>Forge · by <a href="https://timcoy.uk/">Tim Coy</a></span><nav aria-label="Footer"><a href="${esc(home)}/docs/self-hosting">Self-host Forge</a><a href="${esc(home)}/docs">Documentation</a><a href="${repository}">GitHub</a><a href="${esc(operatorContact)}">Operator contact</a><a href="${esc(home)}/privacy">Privacy</a><a href="${repository}/blob/main/LICENSE">MIT licence</a></nav></div></footer>`;
}

export function publicPage(options: PageOptions & { home: string; section?: 'docs' }): Response {
  const home = esc(options.home);
  const navigation = `<nav class="site-nav" aria-label="Main"><a href="${home}/docs"${options.section === 'docs' ? ' aria-current="true"' : ''}>Docs</a><a href="${repository}">GitHub ${arrow}</a><a class="btn primary nav-start" href="${home}/docs/self-hosting">Self-host Forge ${arrow}</a></nav>`;
  return page({ ...options, wide: true, navigation, css: `@font-face{font-family:Onest;src:url('${home}/fonts/onest-variable.ttf') format('truetype');font-weight:100 900;font-style:normal;font-display:swap}${PUBLIC_CSS}${options.css ?? ''}` });
}

export function documentationResponse(home: string, slug: string): Response {
  const doc = documentationPage(home, slug);
  const navigation = documentationNavigation(home).map(link => `<a href="${esc(link.href)}"${link.slug === doc?.slug ? ' aria-current="page"' : ''}>${esc(link.title)}</a>`).join('');
  if (!doc) return publicPage({ home, section: 'docs', title: 'Page not found — Forge', status: 404, body: `<section class="not-found"><h1>This page isn’t here.</h1><p>Find the setup guide, self-hosting instructions and source in the documentation.</p><a class="btn primary" href="${esc(home)}/docs">Open documentation ${arrow}</a></section>${publicFooter(home)}` });
  const contents = doc.toc.filter(heading => heading.level === 2).map(heading => `<a href="${esc(heading.href)}">${esc(heading.text)}</a>`).join('');
  const adjacent = [doc.previous && `<a href="${esc(doc.previous.href)}"><span>Previous</span>${esc(doc.previous.title)}</a>`, doc.next && `<a href="${esc(doc.next.href)}"><span>Next</span>${esc(doc.next.title)} ${arrow}</a>`].filter(Boolean).join('');
  return publicPage({
    home, section: 'docs', title: `${doc.title} — Forge`, index: true, cache: 'public,max-age=300',
    head: `<meta name="description" content="${esc(doc.title)}: Forge documentation, from connecting GitHub to running your own instance."><link rel="canonical" href="${esc(home)}/docs${slug === 'overview' ? '' : `/${esc(slug)}`}">`,
    body: `<div class="docs-layout"><aside class="docs-sidebar"><a class="docs-home" href="${esc(home)}/docs">Documentation</a><nav aria-label="Documentation">${navigation}</nav><a class="source-link" href="${repository}">View repository ${arrow}</a></aside><div class="docs-center"><details class="docs-mobile-nav"><summary>Documentation menu</summary><nav aria-label="Documentation on mobile">${navigation}</nav></details>${contents ? `<details class="docs-mobile-contents"><summary>On this page</summary><nav aria-label="Sections on this page">${contents}</nav></details>` : ''}<article class="docs-prose">${doc.bodyHTML}</article><nav class="docs-adjacent" aria-label="Adjacent pages">${adjacent}</nav><a class="source-link" href="${esc(doc.sourceGitHubHref)}">Read this source on GitHub ${arrow}</a></div><aside class="docs-contents"><nav aria-label="On this page"><strong>On this page</strong>${contents}</nav></aside></div>${publicFooter(home)}`
  });
}

const PUBLIC_CSS = `
.public-site{color-scheme:light;--bg:#fff;--panel:#f5f6f8;--ink:#202526;--muted:#575f62;--line:#e1e5e6;--ring:#2349e8;--blue:#2349e8;--blue-deep:#1835ad;--blue-wash:#edf1ff;background:var(--bg);font-family:Onest,ui-sans-serif,system-ui,sans-serif}
.public-site .wrap{width:min(100% - 5rem,82rem)}
.public-site .topbar{height:92px;padding:0;border:0;gap:2rem}
.public-site .mark{font-size:1.5rem;letter-spacing:-.035em;gap:.6rem}
.public-site .mark .box{border:0;background:transparent;width:30px;height:34px}
.public-site .mark svg{width:30px;height:30px}
.public-site .site-nav{display:flex;align-items:center;gap:2rem;font-size:.88rem}
.public-site .site-nav>a{display:inline-flex;align-items:center;gap:.4rem;text-decoration:none;min-height:44px}
.public-site a:hover{text-decoration-color:var(--blue);color:var(--blue)}
.public-site .btn{border-radius:7px;gap:.65rem;min-height:48px;padding:.7rem 1.15rem;font-size:.91rem}
.public-site .btn.primary{background:var(--blue);color:#fff;border-color:var(--blue)}
.public-site .btn.primary:hover{background:var(--blue-deep);border-color:var(--blue-deep);opacity:1}
.public-site .btn:active{transform:translateY(1px)}
.public-site h1,.public-site h2,.public-site h3{letter-spacing:-.035em;font-weight:500;overflow-wrap:normal}
.public-site p{line-height:1.65}
.public-site .site-footer{margin:0;padding:4rem 0 2rem;border-color:var(--line)}
.public-site .footer-line{display:inline-block;max-width:22ch;font-size:clamp(1.6rem,3vw,2.5rem);font-weight:500;line-height:1.2;letter-spacing:-.035em;text-decoration:none;color:var(--ink);margin-bottom:3.5rem}
.public-site .site-footer>div{display:flex;justify-content:space-between;gap:1.5rem;flex-wrap:wrap}
.public-site .site-footer nav{display:flex;gap:1.5rem;flex-wrap:wrap}
.public-site .site-footer nav a{text-decoration:none}
.public-site ::selection{background:#ced8ff;color:#182a72}
.public-site :focus-visible{outline:2px solid var(--blue);outline-offset:4px}
.public-site .source-link{display:inline-flex;align-items:center;gap:.4rem;font-size:.8rem;color:var(--muted);text-decoration:none}
.docs-layout{display:grid;grid-template-columns:178px minmax(0,1fr) 166px;gap:3.5rem;padding:3rem 0 5rem;border-top:1px solid var(--line);align-items:start}
.docs-sidebar,.docs-contents{position:sticky;top:2rem;max-height:calc(100dvh - 4rem);overflow:auto}
.docs-home{font-size:.87rem;font-weight:600;text-decoration:none;display:block;margin:0 0 1.1rem}
.docs-sidebar nav,.docs-mobile-nav nav{display:flex;flex-direction:column;gap:.25rem;margin:0 0 2rem}
.docs-sidebar nav a,.docs-mobile-nav nav a{padding:.55rem .7rem;margin-left:-.7rem;line-height:1.35;font-size:.83rem;text-decoration:none;border-radius:5px;color:var(--muted)}
.docs-sidebar a[aria-current=page],.docs-mobile-nav a[aria-current=page]{color:var(--blue);background:var(--blue-wash);font-weight:500}
.docs-contents nav{display:flex;flex-direction:column;gap:.7rem;font-size:.74rem;line-height:1.5}
.docs-contents strong{font-weight:500;margin-bottom:.4rem;color:var(--ink)}
.docs-contents a{color:var(--muted);text-decoration:none}
.docs-center{min-width:0}
.docs-prose{font-size:.94rem;line-height:1.75;max-width:72ch;margin:auto;color:var(--ink);overflow-wrap:anywhere}
.docs-prose h1{font-size:2.4rem;line-height:1.15;margin:0 0 1.65rem;text-wrap:balance}
.docs-prose h2{font-size:1.55rem;line-height:1.3;margin:3rem 0 1rem;scroll-margin-top:2rem}
.docs-prose h3{font-size:1.13rem;margin:2rem 0 .75rem;scroll-margin-top:2rem}
.docs-prose h4{font-size:1rem;margin:1.5rem 0 .5rem}
.docs-prose p{color:var(--muted);margin:0 0 1.1rem}
.docs-prose ul,.docs-prose ol{padding-left:1.3rem;margin:1rem 0 1.5rem;color:var(--muted)}
.docs-prose li{padding-left:.2rem;margin:.5rem 0}
.docs-prose li>p{margin-bottom:.5rem}
.docs-prose a{color:var(--blue);text-decoration-color:#a1b1f4}
.docs-prose a:hover{text-decoration-color:var(--blue)}
.docs-prose strong{color:var(--ink);font-weight:600}
.docs-prose pre{padding:1.2rem;background:var(--panel);border-radius:8px;overflow:auto;font-size:.78rem;line-height:1.7;margin:1.5rem 0;tab-size:2}
.docs-prose pre code{overflow-wrap:normal;white-space:pre;font-size:inherit}
.docs-prose :not(pre)>code{background:var(--panel);padding:.12rem .3rem;border-radius:4px;color:var(--ink);font-size:.84em}
.docs-prose blockquote{margin:1.5rem 0;padding:1rem 1.25rem;background:var(--panel);border-radius:8px}
.docs-prose blockquote p:last-child{margin-bottom:0}
.docs-table-scroll{overflow:auto;margin:1.5rem 0;scrollbar-gutter:stable}
.docs-prose table{margin:0;font-size:.8rem;line-height:1.65;min-width:360px}
.docs-prose th{font-size:.76rem;color:var(--ink);text-transform:none;letter-spacing:0;background:var(--panel);white-space:normal}
.docs-prose th,.docs-prose td{padding:.75rem;min-width:100px;overflow-wrap:anywhere}
.docs-prose hr{border:0;border-top:1px solid var(--line);margin:2.5rem 0}
.docs-prose img{max-width:100%;height:auto}
.docs-adjacent{display:flex;justify-content:space-between;gap:1rem;margin:3rem 0 1.75rem;padding-top:1.5rem;border-top:1px solid var(--line)}
.docs-adjacent a{flex:1;text-decoration:none;font-size:.88rem;font-weight:500;max-width:50%}
.docs-adjacent a:last-child{text-align:right;margin-left:auto}
.docs-adjacent span{display:block;font-size:.74rem;color:var(--muted);font-weight:400;margin-bottom:.25rem}
.docs-adjacent svg{vertical-align:middle}
.docs-mobile-nav,.docs-mobile-contents{display:none}
.docs-mobile-contents{border-bottom:1px solid var(--line);margin-bottom:2rem;font-size:.86rem}
.docs-mobile-contents summary{cursor:pointer;min-height:44px;padding:.4rem 0 1rem;font-weight:500}
.docs-mobile-contents nav{display:flex;flex-direction:column;padding:.25rem 0 1rem;gap:.25rem}
.docs-mobile-contents nav a{padding:.6rem 0;min-height:44px;line-height:1.5;text-decoration:none;font-size:.82rem;color:var(--muted)}
.not-found{padding:5rem 0 7rem}.not-found p{max-width:50ch;margin:1.5rem 0}
@media(min-width:1500px){.docs-layout{gap:4rem}}
@media(max-width:1150px){.docs-layout{grid-template-columns:160px minmax(0,1fr);gap:2.75rem}.docs-contents{display:none}.docs-mobile-contents{display:block}}
@media(max-width:760px){.public-site .wrap{width:calc(100% - 2.5rem)}.public-site .topbar{height:78px;gap:1rem}.public-site .site-nav{gap:1rem;font-size:.8rem}.public-site .nav-start{display:none!important}.public-site .site-footer{padding:3rem 0 1.5rem}.public-site .footer-line{margin-bottom:2.5rem}.public-site .site-footer>div{flex-direction:column}.public-site .site-footer nav{gap:1rem}.docs-layout{display:block;padding:1rem 0 3.5rem}.docs-sidebar{display:none}.docs-mobile-nav{display:block;border-bottom:1px solid var(--line);margin-bottom:2rem;font-size:.86rem}.docs-mobile-nav summary{cursor:pointer;min-height:44px;padding:.4rem 0 1rem;font-weight:500}.docs-mobile-nav nav{padding:.5rem 0;margin-bottom:1rem}.docs-mobile-nav nav a{min-height:44px}.docs-prose{font-size:.91rem}.docs-prose h1{font-size:2rem}.docs-prose h2{font-size:1.4rem}.docs-adjacent a{font-size:.8rem}}
`;
