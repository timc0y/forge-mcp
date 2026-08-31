import type { Env } from './env';
import { escapeHtml, page } from './ui';

/** A public, operational privacy notice derived from what the worker stores. */
export function privacyPage(env: Env): Response {
  const origin = env.FORGE_PUBLIC_ORIGIN.replace(/\/+$/, '');
  const contact = 'https://timcoy.uk/';

  return page({
    title: 'Forge — privacy',
    home: origin,
    index: true,
    cache: 'public,max-age=300',
    body: `
<h1>Privacy</h1>
<p class="lead">Forge stores the minimum state needed to connect your GitHub account,
  prepare reviewable changes, show captures later and carry out decisions you approve.</p>
<p class="note">Last updated 21 August 2026.</p>

<h2>What Forge stores</h2>
<div class="section">
  <h3>Account and GitHub access</h3>
  <p>Your GitHub numeric user id, current login and Forge GitHub App installation id.
    Forge also keeps one GitHub user credential encrypted at rest. It is used only to
    create a personal repository, because a GitHub App installation token cannot do that.</p>

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
  <p>A capture page contains the public source URL, title and screenshots you requested.
    New captures are mapped to your Forge account for deletion and expire after 30 days.
    The signed link is a bearer link: anyone you give it to can view it until it expires.</p>

  <h3>Usage and analytics</h3>
  <p>Forge stores one daily capture count per user. When PostHog analytics is enabled,
    it receives only product shape: tool name, success or failure, duration, file or
    viewport counts, action and outcome. It never receives repository names, file
    contents, patches, intents, captured URLs or tokens.</p>
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
  database, capture bucket and Browser Rendering. PostHog receives the limited analytics
  described above only when its optional key is configured. Forge does not sell personal data.</p>

<h2>Your controls</h2>
<ul>
  <li>Revoke or narrow the Forge GitHub App installation from GitHub at any time.</li>
  <li>Disconnect Forge from your chat client to stop that client using it.</li>
  <li>Ask for the Forge account and its mapped captures to be deleted.</li>
</ul>
<p>For support or deletion, use one of the public contact links at
  <a href="${escapeHtml(contact)}">timcoy.uk</a> and ask for a private response route.
  Do not send tokens, private repository details or captured-page contents.</p>

<h2>Security and changes</h2>
<p>Forge uses repository-scoped GitHub App access, encrypted storage for the one user
  credential, signed capture and approval links, and explicit approval before Forge merges
  or discards a proposed change. This notice will be updated when the stored data,
  processors or retention behaviour changes.</p>

<footer><a href="${escapeHtml(origin)}">Back to Forge</a> ·
  <a href="${escapeHtml(contact)}">About &amp; contact</a></footer>`
  });
}
