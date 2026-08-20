# Forge worker

The production implementation of Forge: a hosted handoff between a conversation
and GitHub. See [`../SIMPLE.md`](../SIMPLE.md) for the design profile,
[`../docs/plans/forge-v1.md`](../docs/plans/forge-v1.md) for the architecture and
[`../docs/plans/product-route.md`](../docs/plans/product-route.md) for the active
product plan.

This directory is deliberately self-contained. It has no workspace dependencies
and can install, type-check, test and deploy on its own.

## Public surface

Five MCP tools, none with a mode or action parameter:

| Tool | Gate |
|---|---|
| `forge_read` — repositories → tree → change → file contents or patches | free |
| `forge_edit` — durable GitHub writes on a draft change | free |
| `forge_merge` — returns a link a human opens | **approved** |
| `forge_discard` — returns a link a human opens | **approved** |
| `forge_see` — public-page screenshots plus a compact semantic outline | free, quota'd |

HTTP route families:

- `/` — landing or GitHub installation return page
- `/privacy` — public operational privacy notice
- `/mcp` — authenticated MCP transport
- `/.well-known/oauth-*` and `/oauth/*` — discovery and OAuth 2.1/PKCE
- `/approvals/:id` — durable merge and discard decisions
- `/see/:id` — signed hosted capture
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
boundary, dynamic client registration, invalid approval and capture links, and
the MCP authentication boundary. A real ChatGPT/GitHub run is recorded separately
under [`../docs/test-runs/`](../docs/test-runs/).

## Deployment configuration

Committed, non-secret configuration lives in `wrangler.jsonc`. Production and
development D1 databases, R2 buckets, Durable Object bindings, routes and GitHub
App identifiers are already named there.

Required secrets:

- `GITHUB_APP_PRIVATE_KEY` — PKCS#8 PEM
- `GITHUB_APP_CLIENT_SECRET`
- `FORGE_SIGNING_KEY` — 32+ random bytes
- `CLOUDFLARE_API_TOKEN` — Browser Rendering only
- `POSTHOG_API_KEY` — optional; absence makes analytics a no-op

The GitHub App needs **Contents: write**, **Pull requests: write** and
**Metadata: read**. Expiring user tokens should be enabled so the encrypted
credential used only for repository creation can rotate.

The preview is open to anyone who completes GitHub OAuth and installs the App.
There is no invite table or invite code. Cost is bounded by a per-user daily
capture quota; repository calls use each person's own GitHub installation rate
limit.

## Deliberate boundary

No containers, shell, builds, tests, deployment, preview hosting, private-page
browsing or site crawl. One Durable Object, one database, one capture bucket and
one paid action.

`forge_see` returns images inline and stores a signed HTML copy because MCP
clients disagree about rendering image content. The same Cloudflare snapshot
also returns an accessibility tree; Forge now reduces it to a bounded semantic
outline so a model can reason about page structure without receiving the raw
browser tree.
