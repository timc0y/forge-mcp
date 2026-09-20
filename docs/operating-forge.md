# Operating Forge

For whoever runs the deployment. If you only want to *use* Forge, read
[using-forge.md](./using-forge.md).

## What is deployed

One Worker, one D1 database and one Durable Object. No R2, containers, queues,
workflows or cron. Nothing runs between requests, so there is nothing to reap
and nothing to babysit.

| | Production | Development |
|---|---|---|
| Worker | `forge` | `forge-development` |
| URL | `https://timcoy.uk/forge` | workers.dev |
| D1 | `forge-v1-production` | `forge-v1-development` |

Forge is mounted at a **path**, not a hostname. The router derives that mount
from `FORGE_PUBLIC_ORIGIN`, so moving it is a config change, not a code change.
Both OAuth discovery spellings are served — RFC 8414 puts the well-known segment
before the path, while many clients simply append — which is why there are extra
routes for `/.well-known/oauth-*`.

## Configuration

Non-secret values live in `worker/wrangler.jsonc`.

| Variable | Meaning |
|---|---|
| `FORGE_PUBLIC_ORIGIN` | The public address **including the mount path**. OAuth redirects and approval links are minted from it, and the router takes its mount from it. Load-bearing. |
| `FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS` | Hosts a registering client may redirect to |
| `GITHUB_APP_ID` / `_CLIENT_ID` / `_SLUG` | The GitHub App |
| `FORGE_CAPTURE_DAILY_LIMIT` | Captures per person per UTC day (default 30) |
| `FORGE_UNLIMITED_LOGINS` | GitHub logins exempt from that limit, comma separated. The operator's escape hatch — nothing inside the product grants it |
| `FORGE_JEV_PRIVATE_SOURCE` | `allow` permits bounded private-repository evidence to be processed by the configured JEV route; `deny` refuses semantic context before source is sent |
| `TYPESAFE_BASE_URL` | The single admitted Cloudflare JEV inference route |

Secrets, via `wrangler secret put` from `worker/`:

| Secret | Notes |
|---|---|
| `GITHUB_APP_PRIVATE_KEY` | PKCS#8 PEM (`BEGIN PRIVATE KEY`). Convert GitHub's PKCS#1 download with `openssl pkcs8 -topk8 -nocrypt` before `wrangler secret put`. |
| `GITHUB_APP_CLIENT_SECRET` | |
| `FORGE_SIGNING_KEY` | 32+ random bytes. Signs access and approval tokens, fingerprints rotating refresh-token families, and derives the key encrypting stored GitHub credentials. Rotating it invalidates all of them at once and forces everyone to sign in again |
| `CLOUDFLARE_API_TOKEN` | Scoped to Browser Rendering only |
| `TYPESAFE_API_KEY` | Authenticates the configured JEV route; semantic operations refuse when it is absent |

### The GitHub App

Needs **Contents: write**, **Pull requests: write**, **Metadata: read**, a
callback URL of `<FORGE_PUBLIC_ORIGIN>/oauth/callback`, and **expiring user
tokens enabled** — without that GitHub issues no refresh token and the stored
credential used for new-repo creation and explicit public GitHub search can never rotate.

It additionally needs **Administration: read and write** if `forge_edit` is to
create a repository that does not exist yet. `POST /user/repos` answers 403
("Resource not accessible by integration") without it, and no amount of retrying
changes that. Without the permission, Forge still commits to any repository that
already exists; only creation is refused, with a message naming this permission
and the one-click alternative at `https://github.com/new`.

Enabling the permission changes the App's installation, so the owner of the
account it is installed on approves it once. Existing user authorizations keep
working; a user only reconnects if creation still returns 403.

Verified 2026-09-20: the production App holds Administration, Contents, Pull
requests, Metadata and Workflows, and one `forge_edit` call created
`timc0y/forge-self-test` from a document — the headline promise, proven end to
end.

Forge V2 additionally reads exact-commit check runs and repository-produced
analysis artifacts. Those capabilities require **Checks: read** and **Actions:
read** on the GitHub App. They are capability requirements, not optional
fallbacks: until an installation grants them, Forge reports the evidence as
unavailable and does not substitute older checks or inferred test state.

## Operational measurements

Forge has no external analytics transport. Shape-only events are written to the
existing Cloudflare logs and may include tool name, success/failure, elapsed
time, byte/count budgets, capture count and context-stage counts. The logger
allow-lists both property names and short labels before emission.

Repository names, source, patches, queries, commit messages, captured URLs,
user identifiers and credentials are not telemetry properties. Observation is
best-effort and can never change a tool result.

JEV is different from telemetry: semantic operations send their bounded state
to the configured Cloudflare inference route. With
`FORGE_JEV_PRIVATE_SOURCE=allow`, relevant private source may therefore be
externally processed by that route. Exact reads, GitHub metadata and durable
writes do not require JEV.

## Public abuse boundary

The in-code capture quota is atomic and each call renders each named viewport at
most once, but it is not the internet-facing rate limiter. Keep Cloudflare rate
limits on `/forge/mcp` and the OAuth mutation endpoints (`/oauth/register`,
`/oauth/authorize`, `/oauth/token`), and keep a Workers Paid spend notification.
Dynamic client registration is necessarily public and otherwise provides an
unbounded way to create D1 rows.

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

## Releasing MCP metadata

A Worker deploy updates server code, but an existing ChatGPT developer-mode
connection may continue using its previously discovered tool metadata. After
changing a tool name, description, input/output schema, annotations, auth
metadata or server instructions:

1. bump `SERVER_VERSION` in `worker/src/mcp.ts`;
2. deploy the Worker;
3. confirm `/forge/health` reports the new version;
4. open the Forge connection in ChatGPT Plugins and choose **Refresh**;
5. verify the discovered tool metadata, then start a **new conversation**.

Do not diagnose cached catalog text as current Worker behavior. If two Forge
connections exist, remove or refresh the stale one before comparing tool
results.

Release 1.1 temporarily accepts the previous cached `forge_edit.intent` shape.
Legacy `intent` is deliberately mapped to review/proposed work, never to a
direct default-branch commit, and the result asks the caller to refresh. Remove
this bridge only after active clients have refreshed to the current `change`
schema.

## Running it

```sh
pnpm check                  # types and invariants
pnpm --dir worker dev
pnpm run deploy             # re-runs worker types/tests, then Wrangler deploys
                            # (bare `pnpm deploy` is pnpm's own command, not this script)
worker/scripts/smoke.sh     # post-deploy HTTP/OAuth/version smoke
```

The smoke test needs no GitHub credentials. It covers the mount path, the auth
boundary, both discovery spellings, dynamic client registration (which exercises
D1 for real), PKCE hardening, and invalid approval links.

## Migrations

Apply migrations before deploying worker code that depends on them. Migration
`0002_capture_ownership.sql` is retained as historical schema from the removed
capture-gallery implementation; current code does not read or write that table.
Migration `0003_security_hardening.sql` adds rotating, hashed OAuth refresh tokens
and is required before code that issues them. Existing signed refresh tokens from
before that migration intentionally stop working after the deploy.

```sh
pnpm exec wrangler d1 migrations apply forge-v1-production --remote
```

## Things that will bite

- **The published MCP catalogue is a frozen snapshot.** Changing a tool's name
  or schema needs a re-scan and a republished version in the client. It is a
  release event, not an edit.
- **A legacy `forge/<name>` branch blocks the fixed `forge` branch.** A git ref
  cannot be both a branch and a directory, so while any `forge/…` ref exists
  GitHub refuses to create `forge` with a bare 422. Writing a change removes a
  legacy ref that holds no commit the default branch does not already have, and
  says so in the result; one that holds commits is refused by name rather than
  deleted.
- **GitHub code search is an index, not the truth.** It can answer 200 with
  `incomplete_results: true` and no matches for code that exists. Forge never
  reads that as absence; a repository-scoped exact or concept search falls back
  to reading the committed files (the repository archive, one request, bounded).
  A `limits` line always says when a result came from committed content rather
  than the index.
- **`FORGE_PUBLIC_ORIGIN` is three things at once** — mount path, approval-link
  origin, and OAuth issuer. Changing it invalidates outstanding approval links.
- **Historical deployments may still have executor-era containers.** The current
  worker creates none, but check `wrangler containers list` before assuming an
  old deployment was fully removed.
- **A reinstall replaces the installation id.** Uninstalling and installing the
  App again gives GitHub a new installation id, and nothing tells Forge. The
  stored id then names an installation that no longer exists, so the first token
  mint is a 404 and the session used to register no tools at all. Session startup
  now re-derives the current installation from the App's own list and remembers
  it. If tools still do not appear after a reinstall, check
  `SELECT installation_id FROM users` against `GET /app/installations` for the
  App.
