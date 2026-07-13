# Operations runbook

## Pre-deployment validation

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm cf:typegen
pnpm --filter @forge/edge-gateway exec wrangler deploy --dry-run \
  --config ../../infra/wrangler/forge.development.jsonc
```

A dry run proves bundling and configuration shape only. It does not prove Sandbox allocation, Browser Run, OAuth, D1, R2, Workflows or preview routing.

## Shared development deployment

1. Create isolated development D1 and R2 resources and replace placeholder IDs.
2. configure `FORGE_DEV_AUTH_TOKEN`, `FORGE_CAPABILITY_SIGNING_KEY` and `FORGE_INTERNAL_PREVIEW_KEY` as Worker secrets;
3. deploy the development Worker and apply D1 migrations;
4. invoke `/health` and the RFC 9728 metadata endpoint;
5. run the public Astro/Vite acceptance path through a real MCP client;
6. capture workflow IDs, workspace state transitions, screenshot artifact hash and teardown evidence;
7. verify the preview and capability fail after destruction;
8. record the deployment date, Worker version, Sandbox SDK version and Cloudflare account/environment in the PR evidence.

Production deployment is blocked until the egress-policy spike demonstrates private-range and metadata blocking in the real Sandbox environment.

## Incident handling

1. Check `/health`, Worker errors, Workflow failures, Durable Object state and Sandbox provider status.
2. Locate by trace ID, operation ID and workspace ID; never expose raw provider IDs in user communication.
3. For a stuck workspace, revoke previews, stop processes, persist redacted diagnostics, then destroy or snapshot according to policy.
4. For GitHub authorization changes, revoke capabilities immediately and reconcile installations.
5. Never retrieve secrets from logs. Rotate signing keys and invalidate capabilities if leakage is suspected.
