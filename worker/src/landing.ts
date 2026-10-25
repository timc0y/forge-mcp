import type { Env } from './env';
import { escapeHtml, forgeGlyph, page } from './ui';
import { arrow, publicFooter, publicPage } from './public-site';

export function installedPage(env: Env, _action: string): Response {
  const origin = env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, '');
  return page({
    title: 'Forge — verify your connection',
    home: origin,
    body: `
<h1>Verify your connection</h1>
<p class="lead">You have returned from GitHub. This page cannot confirm installation or repository access.</p>
<p>A GitHub App installation and a chat connection are separate. Only accounts enabled by this instance’s operator can connect.</p>
<h2>Connect your chat</h2>
<p>Use the server URL provided privately by your operator in your client’s MCP connection settings, then continue with GitHub.</p>
<p>After connecting, ask Forge to read a file in a repository you selected. If you already connected, return to your chat and verify that read.</p>
<div class="row"><a class="btn" href="${escapeHtml(origin)}/docs/using-forge">Connection guide</a></div>
<footer>Review or revoke the App’s repository access in your GitHub settings.</footer>`
  });
}

export function landingPage(env: Env): Response {
  const home = env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, '');
  const origin = escapeHtml(home);
  return publicPage({
    home, title: 'Forge — bring the conversation into your project',
    index: true, cache: 'public,max-age=300',
    head: `<meta name="description" content="Read GitHub projects and save research, decisions and changes as ordinary commits. Open source under MIT. Run your own Forge.">
<link rel="canonical" href="${origin}"><meta property="og:title" content="Forge — bring the conversation into your project">
<meta property="og:description" content="Research, decisions and changes. From your conversation to GitHub. Open source. Run your own copy."><meta property="og:image" content="${origin}/icon.png"><meta property="og:url" content="${origin}"><meta name="twitter:card" content="summary">`,
    css: LANDING_CSS,
    body: `
<section class="home-intro">
  <h1>Bring the conversation<br>into your project.</h1>
  <div class="intro-bottom"><p>Research, decisions and changes shouldn’t get lost in a chat.<br class="desktop-break"> Forge gives them a home in GitHub. Open source. Run your own copy.</p><div class="intro-actions"><a class="btn primary" href="${origin}/docs/self-hosting">Run your own Forge ${arrow}</a><a class="btn secondary" href="https://github.com/timc0y/forge-mcp">Source on GitHub ${arrow}</a></div></div>
</section>
<figure class="handoff">
  <figcaption><span>A conversation, carried through.</span><span>Illustrative example</span></figcaption>
  <div class="handoff-sheets">
    <section class="conversation" aria-label="Example conversation"><div class="sheet-heading"><span class="chat-dot"></span> In your conversation</div>
      <div class="person-message">We’ve decided to use the existing email service. Save the decision so my next coding session can pick it up.</div>
      <div class="forge-message"><span class="demo-mark">${forgeGlyph(18)}</span><div><p>Saved the decision in <code>docs/decisions/email.md</code>.</p><p>The project now has the reason, the constraint and the next step.</p><span class="demo-receipt">Committed to main ${arrow}</span></div></div>
      <div class="conversation-bottom">You decide. Forge saves the work.</div>
    </section>
    <section class="repository-sheet" aria-label="Example document saved to GitHub"><div class="sheet-heading">In your repository <span class="file-path">docs / decisions / email.md</span></div>
      <div class="saved-document"><h2>Use the existing<br>email service</h2><div class="doc-rule"></div><h3>Decision</h3><p>Use the project’s existing email service for account notifications.</p><h3>Why</h3><p>It already owns delivery, retries and templates. A second provider would duplicate that work.</p><h3>Next step</h3><p>Add the notification to the existing sender.</p></div>
      <details class="demo-diff"><summary>See what changed <span>+ 11 lines</span></summary><pre tabindex="0" aria-label="Example changes"><code>+ # Use the existing email service
+
+ ## Decision
+ Use the project’s existing email service for account notifications.
+
+ ## Why
+ It already owns delivery, retries and templates. A second provider would duplicate that work.
+
+ ## Next step
+ Add the notification to the existing sender.
+</code></pre></details>
    </section>
  </div>
  <div class="handoff-caption"><span>Conversation ${arrow} Forge ${arrow} GitHub</span><span>Ready for the next coding session.</span></div>
</figure>
<section class="work-section" id="how-it-works"><div class="section-intro"><h2>Keep the useful part.</h2><p>Work with the repository from the conversation you’re already in. The result is a normal GitHub commit.</p></div>
  <div class="work-list">
    <article><h3>Find the source.</h3><div><p>Ask how the project works. Read the files behind an answer and see where a change belongs.</p><a href="${origin}/docs/using-forge#forge_read">Explore repository reads ${arrow}</a></div></article>
    <article><h3>Save the decision.</h3><div><p>Turn research, a plan or a small edit into committed work. Write directly, or prepare a proposed change in a draft pull request.</p><a href="${origin}/docs/using-forge#forge_edit">See how changes work ${arrow}</a></div></article>
    <article><h3>Check the page.</h3><div><p>Bring a public page back into the conversation as phone and desktop captures. Record what you find in the project.</p><a href="${origin}/docs/using-forge#forge_see">Read about captures ${arrow}</a><p class="capture-note">Capture is enabled by your operator.</p></div></article>
  </div>
</section>
<section class="boundary-section"><h2>GitHub keeps the work.<br>Your coding tools run it.</h2><div><p>Forge focuses on the handoff: authorised reads, committed changes and public-page captures.</p><p>Builds, tests, previews and deployments stay in your coding environment. Merge and discard actions return a link for you to approve.</p><a href="${origin}/docs/architecture">Read the architecture ${arrow}</a></div></section>
<section class="start-section" id="setup"><div><h2>Run your own<br>Forge.</h2><p>Use, adapt and host the MIT-licensed source. You supply your own accounts and pay your providers; client plans are separate.</p><a class="text-link" href="${origin}/docs/release-status">Setup checklist ${arrow}</a></div><div class="start-paths"><article><h3>Start with your own copy</h3><p>Connect your own GitHub App and Cloudflare account. The guide takes you from setup to your first commit.</p><a href="${origin}/docs/self-hosting">Self-hosting guide ${arrow}</a></article><article><h3>Read it. Make it yours.</h3><p>MIT-licensed source, one Worker and five tools. Start with the code or contribute a focused improvement.</p><a href="https://github.com/timc0y/forge-mcp">Explore the source ${arrow}</a></article></div></section>
${publicFooter(home)}`
  });
}

const LANDING_CSS = `
.home-intro{padding:4rem 0 3rem}
.home-intro h1{font-size:clamp(3rem,6.1vw,5.6rem);line-height:1.06;margin:0 0 2rem;letter-spacing:-.04em;font-weight:500}
.intro-bottom{display:flex;justify-content:space-between;align-items:end;gap:2rem}
.intro-bottom p{font-size:1.1rem;line-height:1.6;margin:0;max-width:60ch}
.intro-bottom .btn{flex-shrink:0;margin-bottom:.3rem}
.intro-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.75rem}
.handoff{background:var(--blue);color:#fff;border-radius:12px;margin:0;padding:1.6rem 2.5rem 1.3rem;overflow:hidden}
.handoff figcaption{display:flex;justify-content:space-between;gap:1rem;margin:0 0 1.5rem;color:#e0e6ff;font-size:.76rem;text-transform:none;letter-spacing:0}
.handoff figcaption span:first-child{color:#fff;font-weight:500}
.handoff-sheets{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start}
.conversation,.repository-sheet{min-width:0;background:#fff;color:var(--ink);border-radius:8px;overflow:hidden}
.sheet-heading{display:flex;align-items:center;gap:.55rem;font-size:.8rem;font-weight:500;padding:1.1rem 1.4rem;border-bottom:1px solid var(--line);min-height:55px}
.chat-dot{width:8px;height:8px;background:var(--blue);border-radius:50%}
.file-path{margin-left:auto;font-size:.65rem;color:var(--muted);font-weight:400}
.person-message{margin:2rem 1.7rem 1.8rem 3.5rem;padding:1rem 1.2rem;background:#f0f2f4;border-radius:12px 12px 3px 12px;line-height:1.65;font-size:.9rem}
.forge-message{display:flex;align-items:start;gap:.7rem;margin:0 1.7rem 2rem}
.demo-mark{display:grid;place-items:center;width:25px;height:25px;flex-shrink:0;background:var(--blue);color:#fff;border-radius:6px;font-weight:600;font-size:.78rem}
.forge-message p{font-size:.85rem;color:var(--ink);margin:0 0 .9rem}
.forge-message code{font-size:.78rem;background:var(--panel);padding:.1rem .3rem;border-radius:3px}
.demo-receipt{display:inline-flex;align-items:center;gap:.7rem;font-size:.8rem;color:var(--blue);font-weight:500;padding-top:.4rem}
.conversation-bottom{border-top:1px solid var(--line);padding:1.2rem 1.5rem;font-size:.8rem;color:var(--muted)}
.saved-document{padding:1.8rem 2rem 1.5rem}
.saved-document h2{font-size:1.65rem;line-height:1.15;margin:0 0 1.2rem;font-weight:500}
.doc-rule{height:1px;background:var(--line);margin-bottom:1.2rem}
.saved-document h3{font-size:.75rem;margin:1rem 0 .4rem;font-weight:600;letter-spacing:0}
.saved-document p{font-size:.79rem;line-height:1.65;margin:0;max-width:44ch}
.demo-diff{border-top:1px solid var(--line);font-size:.72rem}
.demo-diff summary{cursor:pointer;list-style:revert;min-height:47px;padding:.85rem 1.5rem;color:var(--blue);font-weight:500}
.demo-diff summary span{float:right;font-size:.8rem;color:#267045}
.demo-diff pre{padding:0 1.5rem 1.2rem;overflow:auto;font-size:.68rem;color:#267045;margin:0;line-height:1.65}
.handoff-caption{display:flex;justify-content:space-between;gap:1rem;margin-top:1.2rem;color:#e0e6ff;font-size:.8rem}
.handoff-caption span:first-child{display:flex;align-items:center;gap:.7rem}
.handoff-caption svg{width:14px}
.work-section{padding:6.5rem 0}
.section-intro{display:grid;grid-template-columns:1fr 1fr;gap:5rem;margin-bottom:2rem;align-items:start}
.section-intro h2,.boundary-section h2,.start-section h2{font-size:clamp(2rem,3.8vw,3.2rem);line-height:1.12;margin:0}
.section-intro p{max-width:43ch;font-size:1.02rem;margin:.3rem 0 0}
.work-list{border-top:1px solid var(--line)}
.work-list article{display:grid;grid-template-columns:1fr 1fr;gap:5rem;padding:2rem 0;border-bottom:1px solid var(--line)}
.work-list h3{font-size:1.4rem;margin:0}
.work-list p{font-size:.96rem;max-width:51ch;margin:0 0 1rem}
.work-list a,.boundary-section a,.start-section a:not(.btn){display:inline-flex;align-items:center;gap:.45rem;font-size:.86rem;text-decoration:none;color:var(--blue);font-weight:500}
.work-list .capture-note{font-size:.8rem;margin:.8rem 0 0}
.boundary-section{display:grid;grid-template-columns:1.15fr 1fr;gap:5rem;background:var(--panel);border-radius:12px;padding:3.5rem;margin-bottom:6.5rem}
.boundary-section h2{font-size:clamp(1.8rem,3vw,2.7rem)}
.boundary-section p{font-size:.91rem;margin:0 0 1rem}
.start-section{display:grid;grid-template-columns:1fr 1fr;gap:6rem;padding-bottom:6rem}
.start-section>div>p{max-width:39ch;margin:1.5rem 0 1rem;font-size:.94rem}
.start-paths article{border-top:1px solid var(--line);padding:1.5rem 0 2rem}
.start-paths h3{font-size:1.1rem;margin:0 0 .6rem}
.start-paths p{font-size:.86rem;margin:0 0 1rem;max-width:52ch}
.endpoint-code{display:block;font-size:.76rem;padding:.7rem .8rem;background:var(--panel);border-radius:5px;margin:1rem 0;overflow-wrap:anywhere}
.start-links{display:flex;flex-wrap:wrap;gap:1rem}
.start-section .start-links a{font-size:.8rem}
@media(prefers-reduced-motion:no-preference){.demo-receipt{animation:receipt 850ms cubic-bezier(.16,1,.3,1) both}@keyframes receipt{from{background-color:#e0e7ff;box-shadow:0 4px 20px #2349e820}to{background-color:transparent;box-shadow:0 0 0 #2349e800}}}
@media(max-width:1000px){.handoff{padding:1.3rem}.sheet-heading{padding:1rem}.file-path{display:none}.person-message{margin:1.5rem 1rem 1.5rem 2rem;font-size:.82rem}.forge-message{margin:0 1rem 1.5rem}.saved-document{padding:1.5rem}.section-intro,.work-list article,.boundary-section{gap:3rem}.start-section{gap:4rem}}
@media(max-width:760px){.intro-actions{justify-content:flex-start}.home-intro{padding:2.5rem 0 2rem}.home-intro h1{font-size:clamp(2.6rem,9.5vw,4rem);line-height:1.08;margin-bottom:1.4rem}.intro-bottom{display:block}.intro-bottom p{font-size:1rem;margin-bottom:1.3rem}.intro-bottom .btn{margin:0}.desktop-break{display:none}.handoff{padding:1rem .8rem;border-radius:9px}.handoff figcaption{font-size:.8rem;gap:.4rem;margin-bottom:1rem}.handoff-sheets{grid-template-columns:1fr;gap:1rem}.sheet-heading{font-size:.8rem;padding:.9rem 1rem;min-height:44px}.file-path{display:block;font-size:.75rem;overflow-wrap:anywhere;min-width:0}.person-message{margin:1.3rem 1rem 1.2rem 2.5rem;font-size:.83rem}.forge-message p{font-size:.81rem}.conversation-bottom{padding:.9rem 1rem}.saved-document{padding:1.5rem}.saved-document h2{font-size:1.5rem}.saved-document p{font-size:.8rem}.handoff-caption{font-size:.8rem;line-height:1.5;flex-direction:column;gap:.3rem}.work-section{padding:4rem 0}.section-intro{display:block;margin-bottom:2rem}.section-intro p{font-size:.94rem;margin:1rem 0 0}.work-list article{grid-template-columns:1fr;gap:.8rem;padding:1.5rem 0}.work-list h3{font-size:1.25rem}.work-list p{font-size:.89rem}.boundary-section{grid-template-columns:1fr;gap:1.5rem;padding:1.6rem;margin-bottom:4rem}.boundary-section p{font-size:.88rem}.start-section{grid-template-columns:1fr;gap:2rem;padding-bottom:3.5rem}.start-section h2 br{display:none}.start-section>div>p{max-width:100%;font-size:.9rem}.start-paths article{padding:1.3rem 0 1.5rem}}
`;
