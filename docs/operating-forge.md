# Operating Forge

For whoever runs the deployment. If you only want to *use* Forge, read
[using-forge.md](./using-forge.md).

## Source and recorded deployment

Forge distributes MIT source for independent self-hosting. The maintainer
instance is private to `timc0y`; the public website explains Forge and routes
visitors to the source and self-hosting guide. There is no public hosted offer.

Source version 2.3.0 uses GitHub's expected-head ref updates and deletion,
unconfirmed approval outcomes, corrected credential recognition and stricter
validation. The [source release](https://github.com/timc0y/forge-mcp/releases/tag/v2.3.0)
records its checks. Publication does not deploy the Worker; `/health` reports the
running version separately.

The public history starts from a clean initial commit. Earlier Git refs and
release receipts have a verified private recovery archive outside this checkout.
Historical SHAs below identify that archive's objects. Resetting public branch
and tag history does not erase existing clones, forks, pull-request refs or caches.

The last deployment recorded before the reset was **2.2.0**, on 24 October 2026
at 08:23 UTC, from `1d963118dfe1604dbfb41b23e9f7324f8db8566a`. Cloudflare version
`8d59ca58-dbd4-4449-8ac3-4db6ea615887` served 100%; deployment
`263f85e5-77ed-47ad-ad4e-20d9e41f8809` recorded that source. Health and the
private/self-hosting homepage were checked again at 12:57 UTC. These are dated
observations; source publication does not establish a newer deployment.

Seven public docs pages render their complete repository Markdown. Native Wrangler
Text/Data rules bundle those sources and the self-hosted Onest font, with the same
rules in the self-host template. No additional content build step or third-party
asset request is required. Keep the whole checkout when building the Worker.

Instance access uses `FORGE_ALLOWED_LOGINS`, an explicit comma-separated list of
GitHub logins. Missing, blank or malformed configuration denies all accounts.
The current stored login is checked on bearer requests, OAuth grants and approval
links; OAuth sign-in refreshes that login. Approval execution rechecks the stored
owner before GitHub requests. Logins are case-insensitive; wildcards are refused.
Production and development admit only `timc0y`. Capture consent is a separate,
narrower list and cannot grant instance access. No billing path was introduced.

MCP POST bodies are bounded at 4 MiB of actual streamed bytes before JSON parsing
or session transport, including absent or misleading Content-Length. The MCP SDK
also limits tool-input elements to 10,000 before schema validation. Keep both
limits: the Agents transport does not expose the SDK's body-size option.

The maintainer's retired untracked `apps/`, `packages/`, `infra/`, `dist/`,
`artifacts/` and `.firecrawl/` directories were archived outside Git on 23 October
2026. The private recovery copy is `~/Backups/forge-mcp-legacy-2026-10-23/`;
its `RESTORE.md` records restoration without overwriting an existing directory.
It includes local state and must remain outside the published repository.

Previous production **2.1.0** deployed on 23 October 2026 at 21:39 UTC, with task-evidence
recovery, write safety, restricted capture, shared D1 inference limits and corrected
setup/deletion docs. Cloudflare version `dfa6772d-30e6-4756-90d6-66b666996a7b`
served 100% of traffic at that observation; deployment `503846f5-c90a-43cf-b05b-33af8aae68f0` carries
tag `2.1.0-wip-dc5715c79fe4`.

This release used the reviewed **uncommitted working tree**, based on
`f3baec373ec4412b3a8d90f235e86d139ef8f6de`; no source commit or push was made.
The version message records runtime-source SHA-256
`dc5715c79fe4b5fadf3ef4b533c9784b74400947752e5a0f7e57625908432228`.
It hashes sorted relative paths followed by NUL, file bytes and NUL for Worker
source, migrations, Wrangler config, parser build script, root/Worker package
manifests and present lockfiles. Documentation is outside that runtime hash.

Production migration `0004_semantic_budget.sql` applied successfully; both semantic
tables and deployed settings were read back: capture login `timc0y`, 200 inference
attempts/day and concurrency 4. The release command passed TypeScript, 315 Vitest
tests and 11 Node fixtures. The deployed bundle is 33.07 MiB against the 48 MiB
internal budget; Cloudflare reported 126 ms startup. Health returned 2.1.0 and all
44 production HTTP/OAuth smoke checks passed. The existing Forge connection read
`README.md:1-6` at `f3baec3`; an out-of-range request returned 85 lines and valid
recovery selector `README.md:85-85`, which also succeeded.

No paid inference, repository write/approval, capture, reconnect or fresh-account
journey was exercised for this release. Live inference/concurrency, provider network
isolation and external spend/edge controls remain unverified. [Going live](./going-live.md)
owns those gates; [self-hosting](./self-hosting.md) owns independent setup.

The preceding production release, **2.0.2**, first deployed on 23 October 2026 from source `5334759`,
Cloudflare version `0c2baf94-fa2b-45a5-bcda-70bdce978d7d`. Its tag and message
identify the source commit. TypeScript, 190 tests and all 44 production HTTP/OAuth
smoke checks passed. Worker startup was 158 ms. The preceding production version
was `5777ec89-1dda-4ec3-9549-19b908485cc6` (2.0.1).

The earlier transport repair remains: Workers rejects `redirect: 'error'` before
inference, so JEV uses `manual` and refuses non-success/redirect responses without
following another route. That release's context compiler offers one representative from
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
That recorded 2.0.2 release had full capture enabled; deployment did not establish
network safety. Deployed 2.1.0 instead allows capture only for explicit
consenting GitHub logins, before quota/provider work. The maintainer config names
`timc0y`; self-hosts must name their own login. Empty denies all, with no wildcard
or public opt-out. Enabled accounts retain arbitrary already-public URLs. The
restriction remains until actual provider proof and an explicit release change.

Further proof on 12 October executed the production refresh-family and quota
functions against actual SQLite with repository migrations. Both revocation
orderings passed; 64 concurrent quota requests admitted exactly one. That recorded deployment had all required secret names and no pending D1
migrations then. That observation predates `0004`; its production application is
recorded in the 2.1.0 release above.

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

One Worker, one D1 database and one Durable Object binding. Current runtime has
no R2 store; this is not evidence that historical capture objects were removed.
No containers, queues,
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

Maintainer non-secret values live in `worker/wrangler.jsonc`. Self-hosts copy
`worker/wrangler.self-host.example.jsonc` and always select their own config, as
[documented](./self-hosting.md).

| Variable | Meaning |
|---|---|
| `FORGE_PUBLIC_ORIGIN` | The public address **including the mount path**. OAuth redirects and approval links are minted from it, and the router takes its mount from it. Load-bearing. |
| `FORGE_ALLOWED_LOGINS` | Explicit GitHub logins admitted to this instance; missing/blank/malformed denies all, including existing connections |
| `FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS` | Hosts a registering client may redirect to |
| `GITHUB_APP_ID` / `_CLIENT_ID` / `_SLUG` | The GitHub App |
| `FORGE_CAPTURE_ALLOWED_LOGINS` | Explicit consenting GitHub logins allowed to capture already-public URLs; empty/absent denies before quota/provider work; no wildcard |
| `FORGE_CAPTURE_DAILY_LIMIT` | Captures per person per UTC day (default 30) |
| `FORGE_UNLIMITED_LOGINS` | GitHub logins exempt from that limit, comma separated. The operator's escape hatch — nothing inside the product grants it |
| `FORGE_SEMANTIC_DAILY_CALL_LIMIT` | Shared paid inference attempts per UTC day; default 200; not a monetary guarantee |
| `FORGE_SEMANTIC_MAX_CONCURRENCY` | Shared in-flight inference calls; default 4; unknown outcome holds a fixed 60-second reservation, without daily refund |
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
Setup instructions omit it. The deployed legacy secret is still present;
removal is a separate operator action and was not performed by this release.
Local secrets belong beside the selected config: self-hosts without a named
environment use `worker/.dev.vars`; maintainer `pnpm dev` uses the complete
`worker/.dev.vars.development`. The latter replaces `.dev.vars`; secret
variants and the two filled self-host configs are ignored by Git.

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
still **private**. The maintainer registration stays private; independent
operators create their own App. V2's additional Checks, Commit statuses and
Actions read permissions must be approved for the instance using them.

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

The shared inference meter uses D1 atomic reservations and daily aggregate
attempts/completed/unknown/input/output counts. Transient reservations use random
IDs without source, paths or user identifiers. Every inference attempt consumes
the daily allowance, even after an unknown provider outcome; capacity remains
quarantined for a fixed 60 seconds in that case. Missing budget state refuses
inference. Completion accounting waits at most 250 ms and at most one quarter of
the remaining operation budget; validated evidence can return with
`accounting: unknown` and the original charge retained. Input/output totals record
reported usage only; missing usage never proves zero provider charge. Apply
migration `0004` before deploying this source.

## Public abuse boundary

The login availability restriction runs before capture quota/provider work. It
limits admitted accounts and does not establish provider network isolation.
The in-code capture quota is atomic and counts attempts after input validation.
Failed provider responses, locally rejected bodies and transport failures remain
counted because browser work may already have occurred. Each call renders each
named viewport at most once. This is not the internet-facing rate limiter. Keep
Cloudflare rate limits on `/forge/mcp` and the OAuth mutation endpoints (`/oauth/register`,
`/oauth/authorize`, `/oauth/token`), and keep a Workers Paid spend notification.
Dynamic client registration is necessarily public and otherwise provides an
unbounded way to create D1 rows.

## Cost

GitHub requests use the person's GitHub App user authorization and rate allowance.
Repository Actions may consume their own allowance or charges. Client plans do
not include Forge hosting, Browser Rendering or JEV. The private deployment operator
pays those providers; self-hosts pay their own Worker, D1, Durable Object, rendering
and inference charges.

Measure rendering duration, inference input/output usage and provider prices.
Per-user capture attempts and shared semantic call/concurrency caps bound work,
not monetary spend. Verify account-level spend notifications and edge rules
separately; their live configuration is not established by local tests. No provider billing
or edge-control changes were made by this release.

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
before that migration intentionally stop working after the deploy. Migration
`0004_semantic_budget.sql` adds shared anonymous inference metering and must be
applied before 2.1.0 code. Production application is recorded above; a new
self-host must apply it to its own database.
The [deletion runbook](./account-deletion.md) inventories all owned tables, handles
historical captures and verifies deletion with foreign keys enabled.

```sh
pnpm exec wrangler d1 migrations apply forge-v1-production --remote
```

## Things that will bite

- **The published MCP catalogue is a frozen snapshot.** Changing a tool's name
  or schema needs a re-scan and a republished version in the client. It is a
  release event, not an edit.
- **A legacy `forge/<name>` branch blocks the fixed `forge` branch.** A git ref
  cannot be both a branch and a directory, so while any `forge/…` ref exists
  GitHub refuses to create `forge` with a bare 422. Version 2.1.0
  refuses and names every collision for deliberate
  cleanup. It does not automatically delete even apparently inert refs: a compare
  followed by deletion can race another writer's commit.
- **GitHub code search is an index, not the truth.** It can answer 200 with
  `incomplete_results: true` and no matches for code that exists. Incomplete
  results never prove absence. Bounded exact-source discovery
  names its committed-source provenance; semantic failure remains explicit and
  is not silently replaced by lexical discovery.
- **`FORGE_PUBLIC_ORIGIN` is three things at once** — mount path, approval-link
  origin, and OAuth issuer. Changing it invalidates outstanding approval links.
- **Historical deployments may still have executor-era containers.** The current
  worker creates none, but check `wrangler containers list` before assuming an
  old deployment was fully removed.
- **App grants and human permissions both apply.** Stored installation ids are
  historical metadata, not credentials. Installing after sign-in can be retried
  in the existing connection; GitHub user-token requests reflect the new grant.
  A revoked or expired user credential requires reconnecting.
