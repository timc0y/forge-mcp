# Operating Forge

For whoever runs the deployment. If you only want to *use* Forge, read
[using-forge.md](./using-forge.md).

## What is deployed

Production **2.0.2** first deployed on 23 October 2026 from source `5334759`,
Cloudflare version `0c2baf94-fa2b-45a5-bcda-70bdce978d7d`. Its tag and message
identify the source commit. TypeScript, 190 tests and all 44 production HTTP/OAuth
smoke checks passed. Worker startup was 158 ms. The preceding production version
was `5777ec89-1dda-4ec3-9549-19b908485cc6` (2.0.1).

The earlier transport repair remains: Workers rejects `redirect: 'error'` before
inference, so JEV uses `manual` and refuses non-success/redirect responses without
following another route. The context compiler now offers one representative from
each selected file before additional blocks, asks JEV which evidence directly
answers the task, and retains that primary body before related callers and tests.
The nominal output allowance is 20 KiB; the hard response ceiling remains 32 KiB.
No provider fallback or automatic inference retry was introduced.

At immutable source `1056c7c`, the configured hosted JEV route returned bounded
packets containing the complete owners for tool registration, capture daily-limit
enforcement and GitHub user-token refresh. Production at `5334759` also returned
bounded source evidence for these three tasks, alongside a successful exact README
read. These are three known-task checks, not a held-out relevance benchmark.
Broader tasks can still return explicit `insufficient`; keep coverage evaluation
open. The public page now states the private-preview installation restriction.

Live Forge reads of `timc0y/rule-of-odds` verified ledger lines 1–6, continuation
through 7–12 at the same commit, and the final line without a further continuation.
An oversized whole-file read returned the explicit line-range instruction, and
an invalid line range retained its validation error. Refresh the client catalogue
to discover the updated description and `at` input; deployment does not refresh it.

Astra approved the source but withheld deployment approval because the capture
network boundary remains incompletely verified. The owner explicitly requested
deployment after that limitation was explained, lifting the earlier hold.
Full capture remains enabled; deployment does not establish network safety.

Further proof on 12 October executed the production refresh-family and quota
functions against actual SQLite with repository migrations. Both revocation
orderings passed; 64 concurrent quota requests admitted exactly one. Production
has all required secret names and no pending D1 migrations.

A live Browser Rendering trial against a public hostname resolving to loopback
returned a target HTTP 403 denial page inside an API success response. Forge now
discloses that target error; TypeScript and 185 tests pass. This observation proves
that particular denial, not the provider's enforcement across all private DNS,
redirect and subrequest paths. The unresolved evidence is Cloudflare confirmation
identifying its enforcement at connection
time and its coverage of those paths. Hostname controls alone do not supply that
proof: [guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/)
exclude Quick Actions, and [outbound Workers](https://developers.cloudflare.com/browser-run/features/outbound-workers/)
do not cover arbitrary HTTPS requests.

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
| `GITHUB_APP_CLIENT_SECRET` | |
| `FORGE_SIGNING_KEY` | 32+ random bytes. Signs access and approval tokens, fingerprints rotating refresh-token families, and derives the key encrypting stored GitHub credentials. Rotating it invalidates all of them at once and forces everyone to sign in again |
| `CLOUDFLARE_API_TOKEN` | Scoped to Browser Rendering only |
| `TYPESAFE_API_KEY` | Authenticates the configured JEV route; semantic operations refuse when it is absent |

The former `GITHUB_APP_PRIVATE_KEY` secret is no longer read by this source.
Existing deployed secrets have not been deleted while production remains held.

### V2 runtime and client refresh

The Worker build compiles the pinned TypeScript 5.9.3 package in browser mode,
then aliases only that import to the generated parser. It has no filesystem
system in the Worker; the analysis CLI still uses the ordinary Node package.
`wrangler check startup` and a parser-backed local Worker read verify this
boundary in addition to the Node test suite.

The selected Cloudflare JEV endpoint wraps its model output in a successful
`Completed` response. Forge validates that envelope and the answers; it accepts
no alternate route or envelope. A real synthetic request verified this contract
on 11 October 2026. A live repository context request returned `insufficient`
when complete mandatory evidence could not fit, so relevance and coverage still
need held-out evaluation before broad use.

V2 access tokens carry the MCP resource audience, and transport session IDs bind
to their authenticated owner. Reconnect after release: old access tokens and
unsigned session IDs are refused; retained refresh credentials can issue new
resource-bound tokens. Refresh the catalog and start a new conversation.

Results include the same evidence in structured and text content, so clients
that read only text still receive files, commit receipts and approval links.
The configured OAuth callbacks now include Cursor’s documented HTTPS agent
callback. Grok Bot’s remote HTTPS/OAuth support is documented, but a successful
connection in the app remains unverified.

GitHub atomically checks the proposal head on merge. Forge checks the reviewed
base just before merging; GitHub provides no atomic base condition. A concurrent
base push in that interval remains a disclosed limitation.

### The GitHub App

Needs **Contents: write**, **Pull requests: write**, **Metadata: read**, a
callback URL of `<FORGE_PUBLIC_ORIGIN>/oauth/callback`, and **expiring user
tokens enabled** — without that GitHub issues no refresh token and the stored
credential used for all work on the person's behalf cannot rotate. Ordinary
repository requests and approvals use the GitHub App user token, so GitHub
enforces both the person's permissions and the App's installed repository grant.
Installation-wide tokens no longer authorize operations. Each request resolves
the stored credential, including requests from an existing MCP session.

GitHub refresh credentials are claimed atomically in D1 before exchange. Concurrent
requests wait briefly for the winner; an older exchange cannot overwrite a newer
sign-in. An interrupted or failed exchange requires reconnecting because the
provider may already have spent the credential. Forge does not retry an uncertain
refresh exchange or reuse its consumed token.

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
`timc0y/forge-self-test` from a document — repository creation is proven end to
end. Provider evidence on 21 September 2026 shows the App registration itself is
still **private**, so it cannot yet be installed by unrelated GitHub accounts.
Making the registration public is a launch gate. V2's additional Checks, Commit
statuses and Actions read permissions must be approved at the same time or
before release.

Forge V2 additionally reads exact-commit Check Runs, legacy Commit Statuses and
repository-produced analysis artifacts. Those capabilities require **Checks:
read**, **Commit statuses: read** and **Actions: read** on the GitHub App. They are capability requirements, not optional
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

The in-code capture quota is atomic and counts attempts after input validation.
Failed provider responses, locally rejected bodies and transport failures remain
counted because browser work may already have occurred. Each call renders each
named viewport at most once. This is not the internet-facing rate limiter. Keep
Cloudflare rate limits on `/forge/mcp` and the OAuth mutation endpoints (`/oauth/register`,
`/oauth/authorize`, `/oauth/token`), and keep a Workers Paid spend notification.
Dynamic client registration is necessarily public and otherwise provides an
unbounded way to create D1 rows.

## Cost

GitHub operations use the person's GitHub App user authorization and its rate
limit. Forge also pays for hosting and JEV inference; semantic requests have
separate bounded budgets. Capture attempts have a per-person daily ceiling.
Workers Paid includes 10 browser hours a month, then $0.09/hour, and Quick Actions
like `/snapshot` are billed on
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

V2 rejects the retired `forge_edit.intent` shape before a write. Refresh cached
clients and use the current `change` schema before authoring.

## Running it

```sh
pnpm check                  # types and invariants
pnpm --dir worker dev
pnpm run deploy             # re-runs worker types/tests, then Wrangler deploys
                            # (bare `pnpm deploy` is pnpm's own command, not this script)
worker/scripts/smoke.sh     # post-deploy HTTP/OAuth/version smoke
```

Wrangler and the `cf` CLI can have separate logins. This release used the existing
`cf` OAuth credential at `~/Library/Preferences/cloudflare/config/default.json`,
after `cf auth whoami` verified access to the configured account. Its `oauth_token`
was supplied as `CLOUDFLARE_API_TOKEN` only to the deployment subprocess, without
printing or saving it elsewhere. This deployment credential is separate from the
Worker's Browser Rendering secret of the same name.

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
- **App grants and human permissions both apply.** Stored installation ids are
  historical metadata, not credentials. Installing after sign-in can be retried
  in the existing connection; GitHub user-token requests reflect the new grant.
  A revoked or expired user credential requires reconnecting.
