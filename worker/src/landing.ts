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
  ['edit', 'forge_edit', 'Writes files. Makes the repo and the change if new', false],
  ['merge', 'forge_merge', 'Sends one link to land a change on main', true],
  ['discard', 'forge_discard', 'Sends one link to throw a change away', true],
  ['see', 'forge_see', 'Screenshots a public page, hands back the images', false]
];

const LIMITS: Array<[string, string]> = [
  ['Free', 'research preview, open to anyone'],
  ['30', 'screenshots per day'],
  ['Unlimited', 'reads, commits and merges'],
  ['Nothing', 'runs — no builds, no deploys']
];

const REFUSALS: Array<[string, string, string]> = [
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
  <p class="note">&ldquo;Make me a repo called weather-notes with a plan doc in it.&rdquo;</p>
</div>

<h2>Not connected yet?</h2>
<p>Add this server to ChatGPT (Settings → Apps &amp; Connectors → Advanced → Developer mode)
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

  const limits = LIMITS.map(([big, small]) => `<div><b>${big}</b><span>${small}</span></div>`).join('');

  const refusals = REFUSALS.map(
    ([ico, name, why]) => `<li>${icon(ico, true)}<b>${name}</b><p>${why}</p><span class="you"></span></li>`
  ).join('');

  const body = `
<section class="hero">
  <h1 class="rise">Build on GitHub<br>from a chat.</h1>
  <p class="lead rise">Forge gives an ordinary conversation two things it has never had:
    <b>hands</b> that write real commits, and <b>eyes</b> that see a rendered page.</p>
  <div class="endpoint"><span>Server</span><code>${escapeHtml(mcp)}</code></div>
  <div class="row"><a class="btn primary" href="${escapeHtml(install)}">Install the GitHub App</a>
    <a class="btn" href="#setup">How it works</a></div>
</section>

${loop()}

<h2>Five tools. Two need you.</h2>
<ul class="tools">${tools}</ul>
<p class="note">You never name a branch — describe the work, and say those words again to continue it.
  A commit is on GitHub the moment a tool returns.</p>

<h2 id="setup">Setting up</h2>
<ol class="steps">
  <li><div><h3>Add the server to your client</h3>
    <p>ChatGPT: Settings → Apps &amp; Connectors → Advanced → Developer mode.
      Claude: Settings → Connectors.</p>
    <code class="block">${escapeHtml(mcp)}</code></div></li>
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
  Screenshot links last 30 days, approval links 7.</footer>`;

  return page({
    title: 'Forge — build on GitHub from a chat',
    body,
    home: origin,
    // The one page meant to be found. Every other surface is about somebody's
    // branch or somebody's screenshot and is deliberately not indexed.
    index: true,
    cache: 'public,max-age=300',
    head:
      `<meta property="og:title" content="Forge — build on GitHub from a chat">` +
      `<meta property="og:description" content="Hands that write real commits, and eyes that see a rendered page.">` +
      `<meta property="og:image" content="${escapeHtml(origin)}/icon.png">` +
      `<meta property="og:url" content="${escapeHtml(origin)}">` +
      `<meta name="twitter:card" content="summary">`,
    css:
      '.loop{display:block;width:100%;height:auto;margin:2.6rem 0 .5rem}' +
      '@media(max-width:560px){.loop{display:none}}'
  });
}
