import type { Env } from './env';
import { escapeHtml, page } from './ui';

/**
 * The one page a person can read.
 *
 * Forge has no dashboard, no console and no observer API — the previous system
 * had all three and each was a surface to keep working, secure and honest. This
 * is the mount point, which would otherwise be a 404, and it answers only what
 * someone can ask before they are a user: what is this, how do I connect it,
 * where does the GitHub App go. Once connected, everything happens in the chat.
 *
 * Written to be scanned, not read. A person arriving here wants the server URL
 * and the install link; the prose exists to make those two make sense, and it
 * is kept short enough that skipping it costs nothing.
 */

/** One icon set, one stroke weight, drawn rather than borrowed from a font. */
const ICONS: Record<string, string> = {
  read: '<path d="M3 5.5h6a2.5 2.5 0 0 1 2.5 2.5v9A2 2 0 0 0 9.5 15H3Zm18 0h-6A2.5 2.5 0 0 0 12.5 8v9A2 2 0 0 1 14.5 15H21Z"/>',
  edit: '<path d="M4 20h16"/><path d="M14.5 4.5 19 9 9.5 18.5 4.5 20l1.5-5Z"/>',
  merge: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7"/><path d="M8.5 6.6c4 .6 5.6 2.4 6.6 5"/>',
  discard: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 12.5h9L17.5 7"/>',
  see: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'
};

function icon(name: string, muted = false): string {
  return (
    `<svg class="ico${muted ? ' mut' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`
  );
}

/**
 * The product in one picture: you talk, Forge writes to GitHub, and what it
 * sees comes back. Drawn rather than described, because the loop is the whole
 * idea and a paragraph of it is the thing people skip.
 */
function loop(): string {
  const node = (x: number, label: string, sub: string) =>
    `<g transform="translate(${x} 34)">` +
    `<rect x="-58" y="-26" width="116" height="52" rx="12" fill="var(--panel)" stroke="var(--line)"/>` +
    `<text x="0" y="-3" text-anchor="middle" fill="var(--ink)" font-size="13" font-weight="600">${label}</text>` +
    `<text x="0" y="14" text-anchor="middle" fill="var(--muted)" font-size="10.5">${sub}</text></g>`;

  return (
    '<svg class="loop" viewBox="0 0 620 128" role="img" ' +
    'aria-label="You ask in a chat, Forge commits to GitHub, and what it sees comes back to you.">' +
    '<defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
    '<path d="M0 0.5 7 4 0 7.5Z" fill="var(--muted)"/></marker></defs>' +
    node(70, 'You', 'in any chat') +
    node(310, 'Forge', 'five tools') +
    node(550, 'GitHub', 'the only copy') +
    '<path d="M132 34h100" stroke="var(--muted)" fill="none" marker-end="url(#ar)"/>' +
    '<path d="M372 34h100" stroke="var(--muted)" fill="none" marker-end="url(#ar)"/>' +
    '<path d="M550 66v26q0 12-12 12H82q-12 0-12-12V66" stroke="var(--muted)" fill="none" ' +
    'stroke-dasharray="4 4" marker-end="url(#ar)"/>' +
    '<text x="310" y="121" text-anchor="middle" fill="var(--muted)" font-size="10.5">' +
    'commits, diffs and screenshots come back</text>' +
    '</svg>'
  );
}

const TOOLS: Array<[string, string, string, boolean]> = [
  ['read', 'forge_read', 'Your repos, a repo&rsquo;s files, or what a change did', false],
  ['edit', 'forge_edit', 'Commits files on a draft change; makes the repo if new', false],
  ['merge', 'forge_merge', 'Sends one link to land a change on main', true],
  ['discard', 'forge_discard', 'Sends one link to throw a change away', true],
  ['see', 'forge_see', 'Captures a public page at phone and desktop', false]
];

const USE_CASES: Array<[string, string]> = [
  ['Research &rarr; repository', 'Save a plan, decision or brief where the next coding session can use it.'],
  ['Live page &rarr; visual review', 'See phone and desktop, then record the findings or make a small correction.'],
  ['Small edit &rarr; draft PR', 'Fix copy, CSS or documentation without opening a terminal or touching main.']
];

const LIMITS: Array<[string, string]> = [
  ['Free', 'research preview, open to anyone'],
  ['30', 'screenshots per day'],
  ['Unlimited', 'reads, commits and merges'],
  ['Nothing', 'runs — no builds, no deploys']
];

const REFUSALS: Array<[string, string, string]> = [
  ['edit', 'Run code', 'Use a coding agent for builds, tests, commands and deployments'],
  ['edit', 'Touch main', 'Only a merge you approved moves your default branch'],
  ['see', 'See private pages', 'Captures need a URL that is already public'],
  ['read', 'Keep a copy', 'GitHub is the only place your work lives']
];

/**
 * Where GitHub returns someone after they install the App.
 *
 * It sends them to the Setup URL with `installation_id` and `setup_action`, and
 * the honest answer to "I just installed this" is not the page that explains
 * what Forge is — they have already decided. It is: it worked, here is the one
 * thing left to do.
 *
 * Which thing that is depends on how they arrived, and Forge cannot tell:
 * installing from GitHub directly is a perfectly normal way to find it, and
 * those people have no client connected yet. So both steps are stated, shortest
 * first, and neither is presented as an error.
 */
export function installedPage(env: Env, action: string): Response {
  const origin = env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, '');
  const mcp = `${origin}/mcp`;
  const updated = action === 'update';

  return page({
    title: updated ? 'Forge — access updated' : 'Forge — installed',
    home: origin,
    body: `
<h1>${updated ? 'Access updated' : 'Forge is installed'}</h1>
<p class="lead">${
      updated
        ? 'Forge can now reach exactly the repositories you chose.'
        : 'Forge can reach the repositories you chose, and nothing else.'
    }</p>

<div class="section alert">
  <p><b>Already connected in a chat?</b> Nothing else to do — go back and ask for something.</p>
  <p class="note">&ldquo;Review my homepage on phone and desktop, then save the findings in the site repository.&rdquo;</p>
</div>

<h2>Not connected yet?</h2>
<p>Add this server to ChatGPT (Settings → Apps → Advanced settings → Developer mode)
  or Claude (Settings → Connectors):</p>
<code class="block">${escapeHtml(mcp)}</code>
<p class="note">You will be asked to continue with GitHub once. That is the last time tokens come up.</p>

<div class="row"><a class="btn" href="${escapeHtml(origin)}">What Forge does</a></div>

<footer>Change which repositories Forge may touch any time from GitHub, without involving Forge.</footer>`
  });
}

export function landingPage(env: Env): Response {
  const origin = env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, '');
  const mcp = `${origin}/mcp`;
  const install = `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`;

  const tools = TOOLS.map(
    ([ico, name, what, gated]) =>
      `<li>${icon(ico, !gated)}<b>${name}</b><p>${what}</p>` +
      `<span class="you${gated ? ' yes' : ''}">${gated ? 'you approve' : 'no approval'}</span></li>`
  ).join('');

  const useCases = USE_CASES.map(
    ([name, what]) => `<article class="card"><h3>${name}</h3><p>${what}</p></article>`
  ).join('');

  const limits = LIMITS.map(([big, small]) => `<div><b>${big}</b><span>${small}</span></div>`).join('');

  const refusals = REFUSALS.map(
    ([ico, name, why]) => `<li>${icon(ico, true)}<b>${name}</b><p>${why}</p><span class="you"></span></li>`
  ).join('');

  const body = `
<section class="hero">
  <h1 class="rise">Think in ChatGPT.<br>Commit safely to GitHub.</h1>
  <p class="lead rise">Forge is the safe handoff between a conversation and your repository:
    research, visual reviews and small edits become <b>real commits</b> and <b>draft pull requests</b>.
    It never runs code or touches <code>main</code> without you.</p>
  <div class="row"><a class="btn primary" href="#setup">Connect Forge</a>
    <a class="btn" href="${escapeHtml(install)}">Choose repositories</a></div>
  <div class="endpoint"><span>Server</span><code>${escapeHtml(mcp)}</code></div>
  <p class="note">Client support varies by plan and surface. Read and screenshot tools remain useful where write actions are unavailable.</p>
</section>

<h2>Three useful first jobs</h2>
<div class="usecases">${useCases}</div>

${loop()}

<h2>Five tools. Two need you.</h2>
<ul class="tools">${tools}</ul>
<p class="note">You never name a branch — describe the work, and say those words again to continue it.
  A commit is on GitHub the moment a tool returns.</p>

<h2 id="setup">Setting up</h2>
<ol class="steps">
  <li><div><h3>Add the server to your client</h3>
    <p>ChatGPT: Settings → Apps → Advanced settings → Developer mode.
      Claude: Settings → Connectors.</p>
    <code class="block">${escapeHtml(mcp)}</code>
    <p class="note">ChatGPT custom write support currently depends on plan, workspace and surface. Use the actions your client enables.</p></div></li>
  <li><div><h3>Continue with GitHub</h3>
    <p>Your client opens a Forge page, then GitHub asks whether to let Forge act as you.
      That is the last time tokens come up.</p></div></li>
  <li><div><h3>Choose what it may touch</h3>
    <p>Authorizing says who you are. Installing says which repositories — all of them or a few,
      changeable any time from GitHub.</p>
    <div class="row"><a class="btn" href="${escapeHtml(install)}">Install the App</a></div></div></li>
</ol>

<h2>What it costs</h2>
<div class="spec">${limits}</div>

<h2>What it will not do</h2>
<ul class="tools">${refusals}</ul>

<footer>Open source at <a href="https://github.com/timc0y/forge-mcp">github.com/timc0y/forge-mcp</a>.
  <a href="https://github.com/timc0y/forge-mcp/issues">Support</a>. Screenshot links last 30 days,
  approval links 7.</footer>`;

  return page({
    title: 'Forge — think in ChatGPT, commit safely to GitHub',
    body,
    home: origin,
    // The one page meant to be found. Every other surface is about somebody's
    // branch or somebody's screenshot and is deliberately not indexed.
    index: true,
    cache: 'public,max-age=300',
    head:
      `<meta property="og:title" content="Forge — think in ChatGPT, commit safely to GitHub">` +
      `<meta property="og:description" content="Turn research, visual reviews and small edits into safe GitHub changes.">` +
      `<meta property="og:image" content="${escapeHtml(origin)}/icon.png">` +
      `<meta property="og:url" content="${escapeHtml(origin)}">` +
      `<meta name="twitter:card" content="summary">`,
    css:
      '.usecases{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem;margin:.7rem 0 2rem}' +
      '.usecases h3{margin:0 0 .35rem}.usecases p{margin:0}.hero .endpoint{margin-top:1rem}' +
      '.loop{display:block;width:100%;height:auto;margin:2.6rem 0 .5rem}' +
      '@media(max-width:720px){.usecases{grid-template-columns:1fr}}' +
      '@media(max-width:560px){.loop{display:none}}'
  });
}
