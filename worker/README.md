# Forge worker

The source implementation of Forge: a hosted handoff between a conversation
and GitHub. See [`../SIMPLE.md`](../SIMPLE.md) for the design profile,
[`../docs/plans/context-engine.md`](../docs/plans/context-engine.md) for the active
V2 architecture, [`../docs/plans/forge-v1.md`](../docs/plans/forge-v1.md) for the
historical reset record, and [`../docs/plans/product-route.md`](../docs/plans/product-route.md)
for the active product plan.

Forge distributes MIT source for independent self-hosting. [Operations](../docs/operating-forge.md) and the [release checklist](../docs/going-live.md)
keep deployment, client catalogue and fresh-account proof separate.

This package has no workspace dependencies and can install and run its commands
from this directory. Keep the full checkout: public documentation imports the
Markdown sources from `../docs/`.

## Public surface

Five MCP tools:

| Tool | Forge approval |
|---|---|
| `forge_read` — immutable source/evidence, changes, checks and task context | none |
| `forge_edit` — durable GitHub writes, direct or on the fixed `forge` change | none |
| `forge_merge` — returns a link a human opens | **approved** |
| `forge_discard` — returns a link a human opens | **approved** |
| `forge_see` — public-page screenshots plus a compact semantic outline | allowed accounts with explicit capture consent; quota applies |

HTTP route families:

- `/` — landing or GitHub installation return page
- `/docs` and `/docs/:slug` — seven public guides rendered from repository Markdown
- `/fonts/onest-variable.ttf` — self-hosted Onest font; licence in `assets/fonts/`
- `/privacy` — public operational privacy notice
- `/mcp` — authenticated MCP transport
- `/.well-known/oauth-*` and `/oauth/*` — discovery and OAuth 2.1/PKCE
- `/approvals/:id` — durable merge and discard decisions
- `/health` and icon assets

There is no dashboard, observer API, task console or repository mirror.

## Where it runs

Instances may use a dedicated hostname or a path such as `https://example.com/forge`. The router derives the mount from `FORGE_PUBLIC_ORIGIN`, so the origin,
OAuth issuer and generated links cannot quietly disagree.

## Running it

To use your own accounts, follow [self-hosting](../docs/self-hosting.md) and copy
`wrangler.self-host.example.jsonc`. It names no existing resources or quota
exemptions. That guide has local checks, not a fresh-account deployment claim.
The development command below uses the local-only configuration.

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dev
```

From the repository root:

```sh
pnpm check
worker/scripts/smoke.sh "$FORGE_PUBLIC_ORIGIN"
```

The unauthenticated smoke script covers the mount, OAuth discovery and PKCE
boundary, dynamic client registration, invalid approval links, and the MCP
authentication boundary. Complete a real OAuth and disposable write journey
with your own client separately.

## Deployment configuration

`wrangler.jsonc` is local-only and contains no operator resources. Copy
`wrangler.self-host.example.jsonc` to ignored `wrangler.self-host.jsonc` and
fill your own resources. `pnpm run deploy` validates that explicit file first.

Required secrets:

- `GITHUB_APP_CLIENT_SECRET`
- `FORGE_SIGNING_KEY` — 32+ random bytes
- `CLOUDFLARE_API_TOKEN` — Browser Rendering only
- `TYPESAFE_API_KEY` — the single configured JEV inference route

The GitHub App needs **Contents: write**, **Pull requests: write** and
**Metadata: read** for the core repository surface. Forge V2 also needs
**Checks: read** plus **Commit statuses: read** for complete exact-commit
execution evidence, and **Actions: read** for the versioned
`forge-analysis.json` artifact. Missing permission is reported as
unavailable evidence; Forge never substitutes an older run. Expiring user
tokens should be enabled so the encrypted credential used for repository
creation and explicit public GitHub discovery can rotate.

Every instance requires `FORGE_ALLOWED_LOGINS`, an explicit comma-separated list
of GitHub logins. Missing, blank or malformed lists deny all accounts, including
existing bearer/refresh tokens and approval links. Each operator chooses the
accounts that may connect.

Capture separately requires `FORGE_CAPTURE_ALLOWED_LOGINS`; it cannot grant
instance access. Empty denies capture before quota/provider work. Provider
network isolation remains unresolved. Shared JEV limits default to 200 daily
calls and 4 concurrent calls, backed atomically by D1; these are not monetary
guarantees. Repository calls retain each person's GitHub App user authority.

## Deliberate boundary

No containers, shell, repository execution, deployment, preview hosting,
private-page browsing, persistent repository index, site crawl, object storage
or capture gallery. Repository CI may run normal GitHub Actions independently;
Forge only reads their exact-commit evidence.

`forge_read` pins source to one immutable commit and can return exact files,
symbols/records, checks, a repository-produced analysis artifact or a bounded
JEV-selected context packet. `forge_see` returns public-page images inline with
the call that requested them.
