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
2. configure `FORGE_DEV_AUTH_TOKEN`, `FORGE_CAPABILITY_SIGNING_KEY`, `FORGE_CREDENTIAL_ENCRYPTION_KEY`, `FORGE_INTERNAL_PREVIEW_KEY`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as Worker secrets. The R2 pair must have **Object Read & Write** S3 permission scoped to that environment's backup bucket;
3. deploy the development Worker and apply D1 migrations;
4. invoke `/health` and the RFC 9728 metadata endpoint;
5. run `pnpm acceptance:cloud` through a real MCP client. It waits past the 90-second Sandbox idle limit, verifies a manifest-backed restore, and requires `/ready` to report the resulting recovery evidence. Before a production release, also run it against an installed private repository: `FORGE_ACCEPTANCE_REPOSITORY=owner/private-repo FORGE_ACCEPTANCE_REQUIRE_GITHUB_APP=true pnpm acceptance:cloud`;
6. capture workflow IDs, workspace state transitions, screenshot artifact hash and teardown evidence;
7. verify the preview and capability fail after destruction;
8. record the deployment date, Worker version, Sandbox SDK version and Cloudflare account/environment in the PR evidence.

Production deployment is blocked until the egress-policy spike demonstrates private-range and metadata blocking in the real Sandbox environment.

## GitHub App access

Forge's GitHub App must be **public** when people outside the owning GitHub account need to install it. A private GitHub App intentionally returns GitHub's 404-style denial to non-owners, which makes a normal access request indistinguishable from a broken link. Set visibility in GitHub App settings → Advanced → **Make public**, then verify the GitHub installation flow from a non-owner account. GitHub repository invitations require the recipient's GitHub username; an email address alone is not an installable GitHub identity.

## Incident handling

1. Check `/health`, Worker errors, Workflow failures, Durable Object state and Sandbox provider status.
2. Locate by trace ID, operation ID and workspace ID; never expose raw provider IDs in user communication.
3. For a stuck workspace, revoke previews, stop processes, persist redacted diagnostics, then destroy or snapshot according to policy.
4. For GitHub authorization changes, revoke capabilities immediately and reconcile installations.
5. Never retrieve secrets from logs. Rotate signing keys and invalidate capabilities if leakage is suspected.
