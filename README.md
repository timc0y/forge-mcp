# Parallax Remote

**Disposable, review-ready workspaces for AI apps.**

Parallax Remote gives ChatGPT, Codex and Claude a shared remote computer for repository review while keeping the checkout, package installation, dev server and browser outside the conversation sandbox.

```text
AI host -> authenticated remote MCP -> Cloudflare Worker control plane
                                      -> one ephemeral Cloudflare Container
                                      -> signed preview + R2 evidence
```

This repository is the execution service. [`parallax-review`](https://github.com/timcoy47/parallax-review) remains the product-review contract, personas, journeys, quality packs and evidence format.

## v0.1 scope

Implemented MCP tools:

- `workspace_create`
- `workspace_status`
- `workspace_prepare`
- `workspace_start_service` (port plus an HTTP health path)
- `workspace_logs`
- `browser_capture`
- `workspace_read_file`
- `workspace_search`
- `workspace_diff`
- `workspace_destroy`

The first release is read-only with respect to repository source and GitHub. It can clone, inspect, install, build, start one service, capture screenshots, inspect files and destroy itself. There are no file writes, branches, commits, pushes or pull requests.

## Important status

This is an implementation-ready v0.1 control-plane and container skeleton, not a deployed production service. Before connecting it as a public ChatGPT App, complete the two deliberately separated production pieces:

1. standards-based OAuth and the compact Apps SDK workspace widget;
2. the encrypted per-project secret vault and output redaction path.

The private single-user deployment uses `PARALLAX_API_TOKEN` and refuses to expose repository mutation tools.

## Why a separate repository

`parallax-review` is intentionally host- and browser-coordination logic. Folding cloud execution into that package would couple the stable review contract to Cloudflare lifecycle, GitHub App credentials and infrastructure deployment. Parallax Remote consumes the same repository contract without forking it.

## Runtime

The Worker uses:

- Cloudflare Worker + `ParallaxMcp` Durable Object for Streamable HTTP MCP;
- `WorkspaceContainer` Durable Object for per-workspace lifecycle and RPC;
- Cloudflare Container `standard-3` for 2 vCPU, 8 GiB RAM and 16 GB disk;
- R2 for screenshot artifacts;
- a GitHub App installation token narrowed to one repository and read-only contents;
- Playwright + Chromium inside the container;
- deny-by-default outbound host filtering.

The image includes Git, Node 26, npm, pnpm, Yarn, Bun, Python, ripgrep, Chromium, Playwright and `parallax-review`.

## Local checks

```bash
npm install
npm run check
```

Local Cloudflare Container development additionally requires Docker:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

## Deploy

Create the R2 bucket and configure the secrets documented in [`docs/github-app.md`](docs/github-app.md), then:

```bash
npx wrangler r2 bucket create parallax-remote-artifacts
npm run deploy
```

Set these non-secret production variables in `wrangler.jsonc` or the dashboard:

```text
PUBLIC_ORIGIN=https://remote.parallax.dev
PREVIEW_HOST_SUFFIX=preview.parallax.dev
WORKSPACE_HARD_LIFETIME_MINUTES=60
```

Route `*.preview.parallax.dev/*` to this Worker and configure wildcard DNS/TLS for the preview hostname. Configure an R2 lifecycle rule for short-lived evidence so expired screenshots are removed automatically.

## Example repository configuration

```json
{
  "$schema": "https://remote.parallax.dev/schemas/parallax.remote.schema.json",
  "version": 1,
  "workingDirectory": "apps/redwood",
  "runtime": {
    "node": "26",
    "packageManager": "pnpm"
  },
  "setup": [
    "corepack enable",
    "pnpm install --frozen-lockfile",
    "pnpm --filter @oak-platform/redwood-site build"
  ],
  "services": {
    "web": {
      "command": "pnpm --filter @oak-platform/redwood-site dev --host 0.0.0.0",
      "port": 4321,
      "healthPath": "/"
    }
  },
  "environment": {
    "required": ["PUBLIC_MAPBOX_TOKEN"],
    "optional": ["POSTHOG_API_KEY"]
  },
  "network": {
    "allow": ["api.mapbox.com"]
  }
}
```

Repository configuration is inspection input, not authority. Setup commands and additional network hosts are returned as a proposal and require an explicit tool call before execution.

## Design documents

- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [GitHub App setup](docs/github-app.md)
