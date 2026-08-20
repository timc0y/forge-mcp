# Operating Forge

For whoever runs the deployment. If you only want to *use* Forge, read
[using-forge.md](./using-forge.md).

## What is deployed

One Worker, one D1 database, one R2 bucket, one Durable Object. No containers,
no queues, no workflows, no cron. Nothing runs between requests, so there is
nothing to reap and nothing to babysit.

| | Production | Development |
|---|---|---|
| Worker | `forge` | `forge-development` |
| URL | `https://timcoy.uk/forge` | workers.dev |
| D1 | `forge-v1-production` | `forge-v1-development` |
| R2 | `forge-v1-captures` | `forge-v1-captures-development` |

Forge is mounted at a **path**, not a hostname. The router derives that mount
from `FORGE_PUBLIC_ORIGIN`, so moving it is a config change, not a code change.
Both OAuth discovery spellings are served — RFC 8414 puts the well-known segment
before the path, while many clients simply append — which is why there are extra
routes for `/.well-known/oauth-*`.

## Configuration

Non-secret values live in `worker/wrangler.jsonc`.

| Variable | Meaning |
|---|---|
| `FORGE_PUBLIC_ORIGIN` | The public address **including the mount path**. Every OAuth redirect, approval link and capture link is minted from it, and the router takes its mount from it. Load-bearing. |
| `FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS` | Hosts a registering client may redirect to |
| `GITHUB_APP_ID` / `_CLIENT_ID` / `_SLUG` | The GitHub App |
| `FORGE_CAPTURE_DAILY_LIMIT` | Captures per person per UTC day (default 30) |
| `FORGE_UNLIMITED_LOGINS` | GitHub logins exempt from that limit, comma separated. The operator's escape hatch — nothing inside the product grants it |
| `POSTHOG_HOST` | Analytics endpoint |

Secrets, via `wrangler secret put` from `worker/`:

| Secret | Notes |
|---|---|
| `GITHUB_APP_PRIVATE_KEY` | `wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem` |
| `GITHUB_APP_CLIENT_SECRET` | |
| `FORGE_SIGNING_KEY` | 32+ random bytes. Signs access tokens **and** approval links **and** derives the key encrypting stored GitHub credentials. Rotating it invalidates all three at once and forces everyone to sign in again |
| `CLOUDFLARE_API_TOKEN` | Scoped to Browser Rendering only |
| `POSTHOG_API_KEY` | Optional. Unset means no analytics, not broken analytics |

### The GitHub App

Needs **Contents: write**, **Pull requests: write**, **Metadata: read**, a
callback URL of `<FORGE_PUBLIC_ORIGIN>/oauth/callback`, and **expiring user
tokens enabled** — without that GitHub issues no refresh token and the stored
credential can never rotate.

## Analytics

PostHog, on one rule: **analytics may never change what a caller sees.** Every
send is fire-and-forget, every failure is swallowed, and an unset API key makes
the module a no-op. If PostHog is down, Forge does not notice.

Events are `forge_tool_called`, `forge_user_signed_up`, `forge_user_connected`,
`forge_approval_requested`, `forge_approval_resolved`, `forge_capture_taken`,
`forge_quota_refused`. Properties are shape only — which tool, whether it
worked, the error code, how long it took.

Deliberately never sent: file contents, patches, commit messages, intents,
captured URLs, repository names, tokens. Those are the user's work, and none of
them are needed to know whether the product is usable. `distinct_id` is the
Forge user id, not the GitHub login, because a login can be renamed and would
then look like two people.

## Cost

GitHub work costs nothing — every call is metered against the user's own App
installation. **Capture is the only meter.** Workers Paid includes 10 browser
hours a month, then $0.09/hour, and Quick Actions like `/snapshot` are billed on
hours alone while binding-driven Puppeteer sessions are also billed per
concurrent browser. Forge uses the REST Quick Action, so the concurrency
dimension never applies.

At roughly 5 s a capture, the included 10 hours is about 7,200 captures a month.
Fifty people at 30 a day is ~62 browser hours, about **$4.73 a month in total**.
That 5 s figure is an assumption and should be measured.

## Running it

```sh
pnpm check                  # types and invariants
pnpm --dir worker dev
pnpm --dir worker deploy
worker/scripts/smoke.sh     # 28 checks against a deployment
```

The smoke test needs no GitHub credentials. It covers the mount path, the auth
boundary, both discovery spellings, dynamic client registration (which exercises
D1 for real), PKCE hardening, and that unknown approvals and captures answer
identically to a wrong token.

## Migrations

```sh
wrangler d1 migrations apply forge-v1-production --remote
```

## Things that will bite

- **The published MCP catalogue is a frozen snapshot.** Changing a tool's name
  or schema needs a re-scan and a republished version in the client. It is a
  release event, not an edit.
- **`FORGE_PUBLIC_ORIGIN` is three things at once** — mount path, link origin,
  and OAuth issuer. Changing it invalidates outstanding approval and capture
  links.
- **R2 will not delete a non-empty bucket**, and wrangler has no bulk delete.
  Set a lifecycle rule to expire the objects, then delete the bucket.
- **Deleting a Worker does not delete its containers.** Check
  `wrangler containers list` after removing anything that used them.
