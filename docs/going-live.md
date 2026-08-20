# Going live

What it takes to put Forge in front of strangers, in the order it has to happen.

Written 2026-08-20. The two review processes below change; re-read the linked
sources before acting on the stages that depend on them.

---

## Where this stands

| | |
|---|---|
| Worker deployed at `timcoy.uk/forge` | ✅ |
| D1, R2, Durable Object, routes | ✅ |
| GitHub App created, public, installable by any account | ✅ |
| `FORGE_SIGNING_KEY`, `GITHUB_APP_CLIENT_SECRET` | ✅ (secret verified against GitHub) |
| `GITHUB_APP_PRIVATE_KEY` | ✅ PKCS#8 secret verified by session startup |
| `CLOUDFLARE_API_TOKEN` | ✅ Browser Rendering request verified |
| ChatGPT read, capture, write and approval preparation | ✅ recorded 20 August 2026 |
| Merge approval completed and verified | ❌ not yet recorded |
| Discard approval completed and verified | ❌ not yet recorded |
| Privacy policy | ❌ required by both review processes |
| Support contact | ✅ GitHub issues |

The production trace now proves OAuth, repository access, capture, durable edit,
semantic recovery and approval preparation. The remaining release proof is one
completed merge, one completed discard and the important refusal paths.

## "Public" is three separate things

They get conflated, and only one of them is done.

1. **GitHub App public** — anyone can install it. **Already true.** Nothing
   more to do, no review, no listing.
2. **ChatGPT plugin directory** — a review process with real requirements, and
   the one with a genuine obstacle for Forge. See stage 4.
3. **GitHub Marketplace listing** — optional, and probably not worth it. See
   stage 5.

You can be usefully public with only (1): hand people the server URL and the
install link. Everything else is distribution.

---

## Stage 1 — Finish configuration

**Private key.** Settings → app → Private keys → Generate. Then:

```sh
cd worker
openssl pkcs8 -topk8 -nocrypt \
  -in ~/Downloads/<file>.pem \
  -out ~/.config/forge-mcp/github-app-private-key.pkcs8.pem
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY --env="" \
  < ~/.config/forge-mcp/github-app-private-key.pkcs8.pem
```

GitHub downloads a PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`), while Forge imports
PKCS#8 (`BEGIN PRIVATE KEY`). Uploading the download unchanged lets OAuth finish
but makes authenticated MCP startup fail before any tools are registered.

**Browser Rendering token.** [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
→ Create Custom Token → Browser Rendering: Edit, scoped to the `tims` account.

```sh
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN --env=""
```

**Optional:** `POSTHOG_API_KEY`. Without it analytics is a no-op, by design.

## Stage 2 — Prove it once

A partial production run is recorded in
[`test-runs/production-chatgpt-smoke-2026-08-20.md`](./test-runs/production-chatgpt-smoke-2026-08-20.md).
It reached a real repository, returned screenshots, committed a file, read the
change back and prepared both kinds of approval. Automated checks cannot prove
the remaining human-click paths.

Observed already:

1. Connect, authorize and install.
2. Read a real repository and recover an open change by its human name.
3. Commit a file and read the resulting diff back from GitHub.
4. Capture a public URL with phone and desktop images inline and at a link.
5. Prepare both merge and discard approval links.

Still to record:

6. Continue an existing change with the same intent.
7. Open a merge link on a phone, approve it and confirm the default branch moved.
8. Open a discard link for a second disposable change and confirm its pull
   request closed and branch disappeared.

Then the failure paths, which matter more:

- A fragment that appears twice → refused, not guessed.
- A capture of `http://localhost` → refused.
- An identifier dropped mid-conversation → recovered by name.
- The 31st capture in a day → refused with a reset time (temporarily lower
  `FORGE_CAPTURE_DAILY_LIMIT` rather than taking 31 screenshots).

**Record what happens in `docs/test-runs/`.** The first Forge's traces are the
most useful documents in this repository; this one deserves the same.

## Stage 3 — Harden for strangers

Things that are fine while it is you, and not fine when it is not.

**Abuse.** `forge_see` makes Forge an HTTP client aimed at user-supplied URLs.
Public-host enforcement is the whole defence and it is unit-tested — but add a
Cloudflare **Rate Limiting rule** on `/forge/mcp` before you advertise, because
the quota is per user and account creation is free.

**Cost.** Set a **Cloudflare notification** for Workers Paid spend. The capture
ceiling bounds the browser hours, but "open to anyone" and "no billing alert" is
a bad pair.

**Log retention.** Observability is on. Decide how long, and say so in the
privacy policy.

**Support.** A public thing needs somewhere to complain to. An email or a GitHub
issues link is enough, and Marketplace requires one.

**Deletion.** Someone will ask you to delete their data. Today that is one
`DELETE FROM users WHERE github_login = ?` plus their approvals and captures.
Write it down before you need it — the privacy policy has to promise something
you can actually do.

## Stage 4 — The ChatGPT plugin directory

Apps are now submitted as **plugins**; the app directory migrated to the plugin
directory on 2026-07-09. Submit via the plugin submission portal with *With MCP*,
pointing at the production `/mcp` URL.

### What it needs

- **Identity verification** in the OpenAI Platform Dashboard, under the name you
  will publish as. Individual verification if publishing personally.
- **Domain verification** for `timcoy.uk`.
- **A privacy policy** covering data categories, purposes, recipients, retention
  and user controls. Users read it before installing.
- **Reviewer credentials** — a fully featured demo account with sample data.
- **Five positive and three negative test cases.**
- **Exact CSP domains.**
- **Accurate tool annotations** — named as a common rejection cause. Ours are
  already correct: `forge_read`/`forge_see` read-only, `forge_see` open-world,
  `forge_merge`/`forge_discard` destructive.
- **Retry safety stated.** Ours is real: same intent and content produce the same
  branch and tree, and an identical tree makes no commit.

### The obstacle, stated plainly

**The demo account requirement does not fit Forge.**

Review wants a login and password for an account with sample data, and says
*additional login steps such as sign-ups or 2FA cause rejection*. Forge
authenticates by GitHub OAuth and then requires a GitHub App installation. A
reviewer therefore needs a GitHub account, a consent screen, and an install
step — which is exactly the shape the guideline rejects.

There is no way to remove that: the GitHub grant **is** the product's security
model. What can be done is make it as short as possible:

- Create a dedicated GitHub account for review, with the App already installed
  on two or three repositories holding realistic sample content.
- Hand over that account's credentials, with 2FA arranged so a reviewer is not
  blocked by it.
- In the testing notes, state that authorization is a single "Continue with
  GitHub" click on an already-authorized account, and that the install is
  already done.

Treat approval as genuinely uncertain rather than a formality, and do not build
launch plans that assume it.

### The second risk

Restricted data that must not be collected includes **API keys and
authentication codes**. Forge stores one GitHub user credential per person,
encrypted, and it exists for exactly one reason: creating a repository on your
account, which an installation token cannot do.

If that becomes a blocker, there is a clean answer — **drop repository creation**.
`forge_edit` would refuse for a repository that does not exist and say to create
it on GitHub first. That removes the stored credential entirely, along with
`user-token.ts`, the three `users` columns and the `Administration: Read & write`
permission every installer currently grants.

That is a real trade: the opening move of the product against a smaller security
surface and an easier review. Worth deciding deliberately rather than when a
reviewer forces it.

Also: *return only task-relevant response data; exclude diagnostic metadata,
session IDs and timestamps.* Re-read the five tools' outputs against that before
submitting. `approval.expires` is a timestamp — defensible, since a human needs
to know how long they have, but it is the kind of field a reviewer queries.

Sources: [App submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines),
[Submitting apps to the directory](https://help.openai.com/en/articles/20001040-submitting-apps-to-the-chatgpt-app-directory).

## Stage 5 — GitHub Marketplace (probably skip)

A **free** app needs only the general requirements: valid contact information, a
relevant description, a pricing plan, a working privacy policy link, and a
support link or email. Verified-publisher status and the 100-install minimum
apply only to **paid** apps.

So it is achievable — but it buys discovery you may not want yet, while the
approval-completion paths still lack a recorded production run. The public app page at
`github.com/apps/forge-mcp-github-app` already lets anyone install. Revisit once
there are users.

Source: [Requirements for listing an app](https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app).

## Stage 6 — The privacy policy

Required by both processes and the one piece of work with no code in it. It has
to be true, which means writing it from what the system does:

- **Collected:** GitHub user id and login; a GitHub credential, encrypted, used
  only to create repositories; pending approvals with the diff evidence shown;
  captures; a daily capture count.
- **Not collected:** repository contents at rest, chat transcripts, email.
  Analytics carries tool name, outcome and duration — never file contents,
  patches, intents, captured URLs or repository names.
- **Recipients:** GitHub, Cloudflare (hosting, browser rendering), PostHog
  (analytics) if enabled.
- **Retention:** captures 30 days, approvals 7 days, account data until deletion
  is requested.
- **Controls:** revoke the App from GitHub at any time; request deletion.

Serve it at `/forge/privacy` on the shared page shell, so the link is stable and
matches everything else.

---

## Order

1. Complete and record one merge and one discard approval, plus the refusal paths.
2. Add the rate-limiting rule and billing alert.
3. Serve a truthful privacy policy and write the account-deletion runbook.
4. Decide the stored-credential question before submitting anything.
5. Identity and domain verification. *(days, out of your hands)*
6. Reviewer account with sample data, test cases, submit. *(a day, then weeks)*

Stages 1–4 make Forge genuinely usable by anyone you hand the URL to. Stage 7 is
distribution, and it is the only part with a gatekeeper.
