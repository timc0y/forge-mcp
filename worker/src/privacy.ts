import type { Env } from './env';
import { escapeHtml, page } from './ui';

/** A public, operational privacy notice derived from what the worker stores. */
export function privacyPage(env: Env): Response {
  const origin = env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, '');
  const contact = 'https://timcoy.uk/';
  const privateInference = env.FORGE_JEV_PRIVATE_SOURCE === 'allow'
    ? 'This deployment permits bounded relevant private-repository source to be processed by the configured JEV route when you ask a semantic repository question.'
    : 'This deployment does not send private-repository source to JEV; private semantic repository questions are refused before source leaves Forge.';

  return page({
    title: 'Forge — privacy',
    home: origin,
    index: true,
    cache: 'public,max-age=300',
    body: `
<h1>Privacy</h1>
<p class="lead">Forge stores the minimum state needed to connect your GitHub account,
  prepare reviewable changes and carry out decisions you approve.</p>
<p class="note">Last updated 21 September 2026.</p>

<h2>What Forge stores</h2>
<div class="section">
  <h3>Account and GitHub access</h3>
  <p>Your GitHub numeric user id, current login and Forge GitHub App installation id.
    Forge also keeps one GitHub user credential encrypted at rest. It is used only to
    create a personal repository and when you explicitly ask Forge to search public GitHub.
    Ordinary repository work uses your repository-scoped App installation instead.</p>

  <h3>OAuth connection</h3>
  <p>Registered client names and redirect addresses, hashes of short-lived authorization
    codes, and the user id they belong to. Forge access tokens are signed. Refresh tokens
    are opaque, client-bound, rotate on every use and are stored only as hashes; inactive
    refresh tokens expire after 30 days. Used and expired token records are removed with
    the Forge account and may remain until then so replay can be detected.</p>

  <h3>Changes and approvals</h3>
  <p>GitHub remains the only copy of repository files. For a requested merge or discard,
    Forge stores the repository name, change branch, expected commit, changed-file evidence,
    expiry, decision and outcome. An approval link can act for seven days; its record
    currently remains until the Forge account is deleted.</p>

  <h3>Public-page captures</h3>
  <p>Forge renders public pages on demand and returns screenshots in the tool response.
    It stores only your daily capture count; it does not keep a screenshot gallery or
    persistent copy of captured pages.</p>

  <h3>Usage and analytics</h3>
  <p>Forge stores one daily capture count per user. Shape-only operational measurements
    are written to the existing Cloudflare logs. These measurements contain no repository
    names, source, queries, captured URLs, user identifiers or tokens.</p>
</div>

<h2>What Forge does not keep</h2>
<ul>
  <li>Chat transcripts.</li>
  <li>A mirror, checkout or workspace copy of your repositories.</li>
  <li>Repository secrets or environment variables.</li>
  <li>Private-page captures; Forge accepts only public HTTP or HTTPS URLs.</li>
</ul>

<h2>Who processes data</h2>
<p>GitHub provides identity and repository operations. Cloudflare hosts the Worker,
  database and Browser Rendering. Semantic operations use the configured JEV inference
  route through Cloudflare. Relevant source sent to that route is external processing,
  not local-only analysis. ${escapeHtml(privateInference)} Exact source reads do not
  require inference. Forge keeps no persistent source index and does not sell personal data.</p>

<h2>Your controls</h2>
<ul>
  <li>Revoke or narrow the Forge GitHub App installation from GitHub at any time.</li>
  <li>Disconnect Forge from your chat client to stop that client using it.</li>
  <li>Ask for the Forge account and its stored Forge metadata to be deleted.</li>
</ul>
<p>For support or deletion, use one of the public contact links at
  <a href="${escapeHtml(contact)}">timcoy.uk</a> and ask for a private response route.
  Do not send tokens, private repository details or captured-page contents.</p>

<h2>Security and changes</h2>
<p>Forge uses repository-scoped GitHub App access, encrypted storage for the one user
  credential, signed approval links, and explicit approval before Forge merges or discards
  a proposed change. This notice will be updated when the stored data, processors or
  retention behaviour changes.</p>

<footer><a href="${escapeHtml(origin)}">Back to Forge</a> ·
  <a href="${escapeHtml(contact)}">About &amp; contact</a></footer>`
  });
}
