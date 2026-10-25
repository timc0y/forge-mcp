# Operating Forge

For whoever runs the deployment. If you only want to *use* Forge, read
[using-forge.md](./using-forge.md).

## Source and deployment

Forge distributes MIT source for independent self-hosting. Public pages explain
Forge and setup; deployment configuration and receipts stay with each operator.
Source publication does not deploy a Worker. Verify the running version at your
configured origin’s `/health` endpoint.

Seven public docs pages render their complete repository Markdown. Native Wrangler
Text/Data rules bundle those sources and the self-hosted Onest font, with the same
rules in the self-host template. No additional content build step or third-party
asset request is required. Keep the whole checkout when building the Worker.

Instance access uses `FORGE_ALLOWED_LOGINS`, an explicit comma-separated list of
GitHub logins. Missing, blank or malformed configuration denies all accounts.
The current stored login is checked on bearer requests, OAuth grants and approval
links; OAuth sign-in refreshes that login. Approval execution rechecks the stored
owner before GitHub requests. Logins are case-insensitive; wildcards are refused.
Capture consent is a separate,
narrower list and cannot grant instance access. No billing path was introduced.

MCP POST bodies are bounded at 4 MiB of actual streamed bytes before JSON parsing
or session transport, including absent or misleading Content-Length. The MCP SDK
also limits tool-input elements to 10,000 before schema validation. Keep both
limits: the Agents transport does not expose the SDK's body-size option.

One Worker, one D1 database and one Durable Object binding. Current runtime has
no R2 store; this is not evidence that historical capture objects were removed.
No containers, queues,
workflows or cron. Nothing runs between requests, so there is nothing to reap
and nothing to babysit.

Forge is mounted at a **path**, not a hostname. The router derives that mount
from `FORGE_PUBLIC_ORIGIN`, so moving it is a config change, not a code change.
Both OAuth discovery spellings are served — RFC 8414 puts the well-known segment
before the path, while many clients simply append — which is why there are extra
routes for `/.well-known/oauth-*`.


Capture's provider boundary remains unverified for private DNS, redirects and
subresources. Literal-IP/hostname checks and a single rejected browser trial do
not establish isolation. Keep `FORGE_CAPTURE_ALLOWED_LOGINS` restricted to
consenting accounts until provider enforcement is proved. Browser Run guardrails
and outbound Workers do not establish Quick Action isolation. The remaining
proof belongs in [release status](./going-live.md).

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
Setup instructions omit it. If an older deployment retains it, review and
remove it through the provider after confirming nothing else uses it.
Local secrets belong beside the selected config: self-hosts without a named
environment use `worker/.dev.vars`. Named environments use their own complete
`.dev.vars.<environment>` file, which replaces `.dev.vars`; secret
variants and the two filled self-host configs are ignored by Git.

### V2 runtime and client refresh

The Worker build compiles the pinned TypeScript 5.9.3 package in browser mode,
then aliases only that import to the generated parser. It has no filesystem
system in the Worker; the analysis CLI still uses the ordinary Node package.
`wrangler check startup` and a parser-backed local Worker read verify this
boundary in addition to the Node test suite.

The selected Cloudflare JEV endpoint wraps its model output in a successful
`Completed` response. Forge validates that envelope and the answers; it accepts
no alternate route or envelope. Validate the configured provider route and
measure relevance and coverage on held-out questions before broad use.

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

Automatic Cloudflare invocation logs are separate from these application events.
Both checked-in configurations set `observability.redact_query_string: true`,
which requests removal of URL queries from logs and traces.
The self-host template keeps
observability disabled until the operator chooses retention. After deployment,
read back the actual Worker setting and invoke a disposable non-production URL
with synthetic `t`, `code` and `state` values. Inspect the stored invocation:
the request path should remain and query values should be absent. Do not use a
real approval token for this test. Record the result and retention period; source
configuration alone does not prove deployed redaction or erase older logs.

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
Dynamic client registration is public. The Worker caps the streamed body at
16 KiB, inserts at most 30 clients per rolling hour, and retains at most 1,000
clients. The count and insert are one atomic SQLite statement. At either limit,
registration returns 429; existing clients continue to connect. These storage
bounds do not cap request costs or prevent an attacker consuming the available
registration slots. Edge limits are still required on the custom domain and any
enabled workers.dev route.

Review unused registrations monthly, or when the storage cap is reached. First
inspect candidates with the following predicate, then delete only those same
unused clients older than 30 days. Never delete clients referenced by an OAuth
code or refresh token, even an expired one, without a separate account-retention
review. This preserves existing connections and gives newly registering clients
30 days to complete their first connection.

```sql
SELECT client_id, created_at FROM oauth_clients
WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
  AND NOT EXISTS (SELECT 1 FROM oauth_codes WHERE oauth_codes.client_id = oauth_clients.client_id)
  AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens WHERE oauth_refresh_tokens.client_id = oauth_clients.client_id);
```

Use this same WHERE predicate for an operator-approved deletion. This is a
maintenance action, not a cleanup performed on each unauthenticated request.

## Cost

GitHub requests use the person's GitHub App user authorization and rate allowance.
Repository Actions may consume their own allowance or charges. Client plans do
not include Forge hosting, Browser Rendering or JEV. Each operator
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
worker/scripts/smoke.sh "$FORGE_PUBLIC_ORIGIN" # post-deploy HTTP/OAuth/version smoke
```

Verify the deployment credential's account and Worker permissions before use.
Keep credentials in the operator's local secret store; never print them or put
personal credential/recovery paths in public deployment records.

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
applied before 2.1.0 code. Each operator must apply it to their own database.
The [deletion runbook](./account-deletion.md) inventories all owned tables, handles
historical captures and verifies deletion with foreign keys enabled.

```sh
pnpm exec wrangler d1 migrations apply METADATA --remote --config wrangler.self-host.jsonc
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
