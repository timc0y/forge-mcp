# Forge worker

The production implementation of Forge: a hosted handoff between a conversation
and GitHub. See [`../SIMPLE.md`](../SIMPLE.md) for the design profile,
[`../docs/plans/forge-v1.md`](../docs/plans/forge-v1.md) for the architecture and
[`../docs/plans/product-route.md`](../docs/plans/product-route.md) for the active
product plan.

This directory is deliberately self-contained. It has no workspace dependencies
and can install, type-check, test and deploy on its own.

## Public surface

Five MCP tools:

| Tool | Gate |
|---|---|
| `forge_read` — repositories → tree → change → file contents or patches | free |
| `forge_edit` — durable GitHub writes, direct or on the fixed `forge` change | free |
| `forge_merge` — returns a link a human opens | **approved** |
| `forge_discard` — returns a link a human opens | **approved** |
| `forge_see` — public-page screenshots plus a compact semantic outline | free, quota'd |

HTTP route families:

- `/` — landing or GitHub installation return page
- `/privacy` — public operational privacy notice
- `/mcp` — authenticated MCP transport
- `/.well-known/oauth-*` and `/oauth/*` — discovery and OAuth 2.1/PKCE
- `/approvals/:id` — durable merge and discard decisions
- `/health` and icon assets

There is no dashboard, observer API, task console or repository mirror.

## Where it runs

Production is mounted at `https://timcoy.uk/forge`, a path rather than its own
hostname. The router derives the mount from `FORGE_PUBLIC_ORIGIN`, so the origin,
OAuth issuer and generated links cannot quietly disagree.

## Running it

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dev
```

From the repository root:

```sh
pnpm check
worker/scripts/smoke.sh
```

The unauthenticated smoke script covers the mount, OAuth discovery and PKCE
boundary, dynamic client registration, invalid approval links, and the MCP
authentication boundary. A real ChatGPT/GitHub run is recorded separately under
[`../docs/test-runs/`](../docs/test-runs/).

## Deployment configuration

Committed, non-secret configuration lives in `wrangler.jsonc`. Production and
development D1 databases, Durable Object bindings, routes and GitHub App
identifiers are already named there.

Required secrets:

- `GITHUB_APP_PRIVATE_KEY` — PKCS#8 PEM
- `GITHUB_APP_CLIENT_SECRET`
- `FORGE_SIGNING_KEY` — 32+ random bytes
- `CLOUDFLARE_API_TOKEN` — Browser Rendering only
- `TYPESAFE_API_KEY` — the single configured JEV inference route

The GitHub App needs **Contents: write**, **Pull requests: write** and
**Metadata: read** for the core repository surface. Forge V2 also needs
**Checks: read** for exact-commit execution evidence and **Actions: read** for
the versioned `forge-analysis.json` artifact. Missing permission is reported as
unavailable evidence; Forge never substitutes an older run. Expiring user
tokens should be enabled so the encrypted credential used for repository
creation and explicit public GitHub discovery can rotate.

The preview is open to anyone who completes GitHub OAuth and installs the App.
There is no invite table or invite code. Cost is bounded by a per-user daily
capture quota; repository calls use each person's own GitHub installation rate
limit.

## Deliberate boundary

No containers, shell, repository execution, deployment, preview hosting,
private-page browsing, persistent repository index, site crawl, object storage
or capture gallery. Repository CI may run normal GitHub Actions independently;
Forge only reads their exact-commit evidence.

`forge_read` pins source to one immutable commit and can return exact files,
symbols/records, checks, a repository-produced analysis artifact or a bounded
JEV-selected context packet. `forge_see` returns public-page images inline with
the call that requested them.
