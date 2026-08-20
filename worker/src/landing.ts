import type { Env } from './env';
import { page } from './ui';

/**
 * The one page a person can read.
 *
 * Forge deliberately has no dashboard, no console and no observer API — the
 * previous system had all three and every one was a surface to keep working,
 * secure and honest. This is not that. It is the mount point, which would
 * otherwise be a 404, and it answers the only questions someone can have before
 * they are a user: what is this, how do I connect it, and where does the GitHub
 * App go. Once connected, everything happens in the chat.
 *
 * Self-contained on purpose: no external stylesheet, script, font or image, so
 * it renders the same on a phone with a bad connection as anywhere else, and
 * loading it tells no third party that you use Forge.
 */


export function landingPage(env: Env): Response {
  const origin = env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, '');
  const mcp = `${origin}/mcp`;
  const install = `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`;

  const body = `<h1>Forge</h1>
<p class="lead">Hands and eyes for a mind that can only talk.</p>

<p>A chat has judgement and no way to act. It cannot hold a filesystem, cannot loop, and forgets an identifier the moment a conversation is summarised. Forge gives it two organs and nothing else: <strong>durable authoring in GitHub</strong>, and <strong>sight of rendered pages</strong>. GitHub holds the memory.</p>

<p>Think of something on a walk, and a repository exists with the plan in it before you get home. Iterate on a page from your phone, look at it, change it, look again.</p>

<div class="section alert"><p><strong>Forge does not run your code.</strong> No containers, no shell, no builds, no deployments. It writes to GitHub and it looks at pages that are already public. That is the whole of it.</p></div>

<h2>The five tools</h2>
<table>
<tr><th>Tool</th><th>What it does</th><th class="gate">Needs you</th></tr>
<tr><td><code>forge_read</code></td><td>Your repositories, a repository's files, what a change did, or the contents of specific files</td><td class="gate">no</td></tr>
<tr><td><code>forge_edit</code></td><td>Writes files. Creates the repository if it is new, and the change if the intent is new</td><td class="gate">no</td></tr>
<tr><td><code>forge_merge</code></td><td>Sends you one link to land a change on <code>main</code></td><td class="gate"><strong>yes</strong></td></tr>
<tr><td><code>forge_discard</code></td><td>Sends you one link to throw a change away</td><td class="gate"><strong>yes</strong></td></tr>
<tr><td><code>forge_see</code></td><td>Screenshots a public URL and hands back the images</td><td class="gate">no</td></tr>
</table>

<h3>You never name a branch</h3>
<p>Describe the work — <em>"pricing section"</em> — and say those words again to continue it. Every reply lists what is open in that repository, so nothing has to be remembered between messages. A commit is on GitHub the moment the tool returns; there is nothing to push or confirm afterwards.</p>

<h3>Two things need your hand</h3>
<p><code>main</code> moves only through a merge you approved, and a change is only thrown away if you say so. Both send you a single link showing exactly what would land or be lost. The link keeps working after the conversation ends, so you can decide later, on any device.</p>

<h2>Getting set up</h2>

<div class="section alert"><p>Forge is a <strong>free research preview</strong>, open to anyone with a GitHub account. Captures are limited to 30 a day per person; everything else is unlimited because it runs against your own GitHub allowance.</p></div>

<h3>1. Add Forge to your client</h3>
<p>The server URL is:</p>
<pre><code>${mcp}</code></pre>
<p><strong>ChatGPT</strong> — Settings → Apps &amp; Connectors → Advanced → Developer mode, then add a connector with that URL.</p>
<p><strong>Claude</strong> — Settings → Connectors → Add custom connector, with that URL. Or from Claude Code:</p>
<pre><code>claude mcp add --transport http --scope user forge ${mcp}</code></pre>

<h3>2. Authorize it</h3>
<p>Your client opens a Forge page saying what it is about to be allowed to do. Continue with GitHub from there. GitHub asks whether to let Forge act as you, and that is the last time you have to think about tokens.</p>

<h3>3. Install the GitHub App</h3>
<p>Authorizing tells Forge who you are. Installing tells it <em>which repositories it may touch</em>. They are separate on purpose, and Forge cannot reach anything until you choose:</p>
<pre><code>${install}</code></pre>
<p>Pick every repository or only some. You can change it whenever you like, from GitHub, without involving Forge. Repositories Forge creates for you are reachable automatically.</p>

<h3>4. Say what you want</h3>
<p class="note">"Make me a repo called weather-notes with a plan doc in it." · "Read the homepage of my site repo and tighten the copy." · "Screenshot example.com on phone and desktop." · "Merge the pricing section change."</p>

<h2>What it will not do</h2>
<ul>
<li>Run, build, test or deploy anything.</li>
<li>Write to <code>main</code> without you approving it.</li>
<li>Screenshot anything that is not already publicly reachable.</li>
<li>Keep a copy of your repository. GitHub is the only place your work lives.</li>
</ul>

<footer>Forge is open source: <a href="https://github.com/timc0y/forge-mcp">github.com/timc0y/forge-mcp</a>. Captures expire after 30 days, approval links after 7.</footer>`;

  return page({
    title: 'Forge — build on GitHub from a chat',
    body,
    home: origin,
    // The one page meant to be found. Every other surface is about somebody's
    // branch or somebody's screenshot and is deliberately not indexed.
    index: true,
    cache: 'public,max-age=300'
  });
}
