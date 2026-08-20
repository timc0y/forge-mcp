# Forge V1

Hands and eyes for a mind that can only talk. See [`../SIMPLE.md`](../SIMPLE.md)
for the design profile and [`../docs/plans/forge-v1.md`](../docs/plans/forge-v1.md)
for the plan.

This directory is self-contained: it has no workspace dependencies and installs
on its own, which is why removing the old system will not disturb it.

## The surface

Five tools, none with a mode or action parameter.

| Tool | Gate |
|---|---|
| `forge_read` — repos → tree → a change → file contents or patches | free |
| `forge_edit` — write files; creates the repo and the change if new | free |
| `forge_merge` — returns a link a human opens | **approved** |
| `forge_discard` — returns a link a human opens | **approved** |
| `forge_see` — screenshot a public URL | free, quota'd |

Plus four HTTP routes: `/mcp`, the OAuth endpoints, `/approvals/:id`, `/health`.

## Running it

```sh
pnpm install --ignore-workspace
pnpm typecheck
pnpm test
pnpm dev
```

## Before it can deploy

`wrangler.jsonc` carries `TODO` where real values belong:

- `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG` — a GitHub App with
  **Contents: write**, **Pull requests: write**, **Metadata: read**, and
  **expiring user tokens enabled** (otherwise there is no refresh token and the
  stored credential never rotates).
- `database_id` for both environments — `wrangler d1 create forge-production`.
- Two R2 buckets — `wrangler r2 bucket create forge-captures` (and
  `-development`). Put a 30-day lifecycle rule on each: nothing in the code
  deletes a capture, so expiry is the bucket's job.

Secrets, via `wrangler secret put`:

- `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`
- `FORGE_SIGNING_KEY` — 32+ random bytes. Signs access tokens and approval
  links, and derives the key that encrypts stored GitHub credentials. Rotating
  it invalidates all three at once.
- `CLOUDFLARE_API_TOKEN` — scoped to Browser Rendering only.

Invites are rows: `INSERT INTO invites (code, note, created_at) VALUES (...)`.
No user can be created without one.

## What is deliberately absent

No containers, shell, builds, deploys, previews, or hosting. No site crawl,
no observer API, no dashboard. No Workers AI, no Workflows. One Durable Object,
one database, one bucket, one meter.

`forge_see` returns images inline **and** stores a rendered page at one signed
link. Both, because MCP clients disagree about whether they render inline
images — at least one passes the base64 to the model as text — and because a
human deciding on a merge tomorrow needs the evidence to still exist. Forge 1
learned this in both directions: retrieval-only failed a non-agentic chat, and
inline-only fails a client that will not draw it.
