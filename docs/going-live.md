# Going live

What it takes to put Forge in front of strangers, in the order it has to happen.

Written 2026-08-21. The two review processes below change; re-read the linked
sources before acting on the stages that depend on them.

---

## Where this stands

| | |
|---|---|
| Worker deployed at `timcoy.uk/forge` | ✅ |
| D1, Durable Object, routes | ✅ |
| GitHub App created | ✅ |
| GitHub App public / installable by other accounts | 🟡 **blocked: App currently reports private** |
| `FORGE_SIGNING_KEY`, `GITHUB_APP_CLIENT_SECRET` | ✅ (secret verified against GitHub) |
| `GITHUB_APP_PRIVATE_KEY` | ✅ PKCS#8 secret verified by session startup |
| `CLOUDFLARE_API_TOKEN` | ✅ Browser Rendering request verified |
| ChatGPT read, capture, write and approval preparation | ✅ recorded 20 August 2026 |
| Merge approval completed and verified | ✅ recorded 21 August 2026 |
| Discard approval completed and verified | ✅ recorded 21 August 2026 |
| Privacy policy | ✅ deployed and verified at `/forge/privacy` |
| Support contact | 🟡 public contact links exist; dedicated support address still needed |

The production traces now prove OAuth, repository access, capture, durable edit,
semantic recovery, completed merge and completed discard. The remaining
deployment work is the Cloudflare edge rate limit, Workers Paid spend alert and
dedicated support contact.

The public `timcoy.uk` project listing now describes Forge as the current safe
ChatGPT-to-GitHub handoff.

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

**JEV:** set `TYPESAFE_API_KEY`. Production configuration names the one admitted
Cloudflare inference route and explicitly allows bounded private-source JEV
processing. The privacy page must remain accurate for that processing boundary.

### Current V2 provider blockers — 21 September 2026

Public GitHub API evidence for `timc0y/forge-mcp` currently reports workflow
`CI` (`.github/workflows/ci.yml`, id `311718244`) as `disabled_manually`, and the
`forge` branch has no workflow runs/check runs. The V2 workflow definition now
runs on exact `forge` heads and no longer ignores documentation-only changes;
the remaining action is to enable GitHub Actions/CI in repository settings.
Do not merge V2 until a fresh exact-head run is visible and successful.

Forge V2 also diagnoses inactive workflow states when a revision has no checks;
zero checks never count as passing.

GitHub's public App landing page currently identifies **Forge MCP GitHub App as
a private GitHub App**. GitHub's visibility rules mean a private App can only be
installed on its owning account. Before presenting Forge as open to other GitHub
users, change the App registration to public and complete any permission
approval prompted by that change.

Owner actions, in this order:

1. In GitHub repository Actions settings, enable workflow **CI** (workflow id
   `311718244`). Do not merge merely because the workflow is enabled; wait for a
   run on the latest `forge` SHA.
2. In the Forge MCP GitHub App registration, change visibility from **private**
   to **public**.
3. Ensure the App requests and the installation approves **Checks: read**,
   **Commit statuses: read** and **Actions: read**, in addition to the already
   proven repository permissions.
4. Push or make one harmless commit on `forge` if enabling CI does not replay the
   previous push. Confirm exact-head CI and `Forge analysis` both run.
5. Only after those exact-head runs succeed should `forge_merge` be asked to
   prepare the human merge approval.

### Forge V2 catalog release

Forge V2 changes MCP schemas and server instructions. Deploying Worker code is
not enough for clients that cached the old catalog: refresh/re-scan the Forge
connection and start a new conversation before evaluating V2. The production
GitHub App must also have **Checks: read**, **Commit statuses: read** and
**Actions: read** approved before `checks` and `analysis` can return complete
execution evidence. CI runs on direct `forge` pushes as well as pull requests so
the proposal head itself receives execution evidence; a pull-request synthetic
merge commit is never substituted for the proposal SHA.

## Stage 2 — Prove it once

A partial production run is recorded in
[`test-runs/production-chatgpt-smoke-2026-08-20.md`](./test-runs/production-chatgpt-smoke-2026-08-20.md).
It reached a real repository, returned screenshots, committed a file, read the
change back and prepared both kinds of approval. Automated checks cannot prove
the remaining human-click paths.

Recorded:

1. Connect, authorize and install.
2. Read a real repository and recover an open change by its human name.
3. Commit a file and read the resulting diff back from GitHub.
4. Capture a public URL with phone and desktop images inline and at a link.
5. Prepare both merge and discard approval links.
6. Continue an existing change with the same intent.
7. Approve PR #66 through the mounted approval path and confirm merge commit
   `8e688c81af3219fd2ecd4507e2717e191d27d571` reached `main`.
8. Discard disposable PR #75 through the mounted approval path and confirm its
   pull request closed and `forge/mounted-approval-live-smoke` disappeared.

Then the failure paths, which matter more:

- A fragment that appears twice → refused, not guessed.
- A capture of `http://localhost` → refused.
- An identifier dropped mid-conversation → recovered by name.
- The 31st capture in a day → refused with a reset time (temporarily lower
  `FORGE_CAPTURE_DAILY_LIMIT` rather than taking 31 screenshots).

The hardening and deployment proof is recorded in
[`test-runs/production-hardening-2026-08-21.md`](./test-runs/production-hardening-2026-08-21.md).

## Stage 3 — Harden for strangers

Things that are fine while it is you, and not fine when it is not.

**Abuse.** `forge_see` makes Forge an HTTP client aimed at user-supplied URLs.
The worker rejects local/literal-IP targets, blocks literal private redirect
patterns inside Browser Rendering, caps a call at three viewports, deduplicates
them and reserves quota atomically. That still does **not** replace an edge rate
limit or make arbitrary-host rendering equivalent to a hostname allowlist. Keep
Cloudflare **Rate Limiting rules** on `/forge/mcp` and on `/oauth/register`,
`/oauth/authorize` and `/oauth/token` before advertising; account creation and
dynamic client registration are intentionally public.

**Cost.** Set a **Cloudflare notification** for Workers Paid spend. The capture
ceiling bounds browser hours per authenticated account, but "open to anyone" and
"no billing alert" is still a bad pair.

**Dependencies and history.** Dependabot now watches npm and GitHub Actions.
Run a full-history secret scan before treating a public release as clean: deleting
a credential from `main` does not remove it from old commits. Treat a history
finding as credential rotation work, not merely a file removal. The MCP SDK
remains pinned until its lockfile is deliberately refreshed; review its current
advisories and resolved transitive versions before deployment.

**Log retention.** Observability is on. Decide how long, and say so in the
privacy policy.

**Support.** The worker links to the public contact routes on `timcoy.uk`, which
is enough for design partners but not a durable product support channel. The
source repository is now public, so its Issues page is reachable, but do not
silently turn a code issue tracker into the support contract: either publish a
support/issue policy there or add a dedicated support address before directory
or Marketplace submission.

**Deletion.** Forge V2 stores no captured-page objects. The manual procedure in
[`account-deletion.md`](./account-deletion.md) deletes the user row, OAuth state,
approval evidence and daily capture-usage counter from D1. Revoking the GitHub
App installation remains a separate GitHub action the user controls.

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

So it is achievable — but it buys discovery you may not want yet. The public app page at
`github.com/apps/forge-mcp-github-app` already lets anyone install. Revisit once
there are users.

Source: [Requirements for listing an app](https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app).

## Stage 6 — The privacy policy

Required by both processes and the one piece of work with no code in it. It has
to be true, which means writing it from what the system does:

- **Collected:** GitHub user id and login; a GitHub credential, encrypted, used
  only to create repositories and explicit public GitHub discovery; pending
  approvals with the frozen diff/evidence shown; a daily capture-usage count.
- **Not collected at rest:** repository contents, chat transcripts, email.
  Shape-only Cloudflare logs exclude repository names, source, queries, patches,
  captured URLs and user identifiers.
- **Recipients:** GitHub provides identity/repository operations. Cloudflare
  hosts Forge, Browser Rendering and the configured JEV inference route. When
  private semantic context is enabled, bounded relevant private source may be
  processed by that JEV route; exact reads and writes do not require inference.
- **Retention:** Forge keeps no captured-page object or gallery. Approval links
  expire after seven days, but approval records currently remain until account
  deletion; do not describe link expiry as record deletion.
- **Controls:** revoke the App from GitHub at any time; disconnect the client;
  request deletion through the documented operator procedure.

The worker serves this notice at `/forge/privacy`, and the production route is
verified. Forge V2 keeps no capture gallery or R2 repository/capture store.

---

## Order

1. Complete and record one merge and one discard approval, plus the refusal paths. ✅
2. Add the rate-limiting rule, billing alert and dedicated support contact. 🟡
3. Apply migrations 0002 and 0003, deploy and verify the privacy route, OAuth reconnect/refresh and deletion runbook. ✅
4. Decide the stored-credential question before submitting anything.
5. Identity and domain verification. *(days, out of your hands)*
6. Reviewer account with sample data, test cases, submit. *(a day, then weeks)*

Steps 1–3 make Forge safe to put in front of design partners. Step 6 is public
distribution, and it is the only part with an external gatekeeper.
