# Operations runbook

## Pre-deployment validation

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm cf:typegen
pnpm --filter @forge/edge-gateway exec wrangler deploy --dry-run \
  --config ../../infra/wrangler/forge.jsonc
```

A dry run proves bundling and configuration shape only. It does not prove Sandbox allocation, Browser Run, OAuth, D1, R2, Workflows or preview routing.

## Deployment

Forge has a single deployable environment defined by `infra/wrangler/forge.jsonc`.
Production is the top-level environment; development uses the same file with
`--env development`.

```bash
pnpm wrangler login       # Cloudflare OAuth (no global wrangler binary required)
pnpm run deploy           # Worker + Sandbox image — Docker Desktop must be running
pnpm run deploy:worker    # Worker-only when Dockerfile did not change
```

Local iteration runs the same config with an auth-relaxed identity:

```bash
pnpm dev
```

1. Ensure the isolated development and production D1 and artifact R2 resources exist and match the IDs and names in `forge.jsonc`.
2. configure `FORGE_DEV_AUTH_TOKEN`, `FORGE_CAPABILITY_SIGNING_KEY`, `FORGE_CREDENTIAL_ENCRYPTION_KEY` and `FORGE_INTERNAL_PREVIEW_KEY` as Worker secrets;
3. deploy the Worker and apply D1 migrations;
4. invoke `/health` and `/ready`, plus the RFC 9728 metadata endpoint;
5. run `pnpm acceptance:cloud` through a real MCP client. It waits past the 90-second Sandbox idle limit and verifies that a subsequent execution materializes the GitHub branch afresh. Before a production release, also run it against an installed private repository: `FORGE_ACCEPTANCE_REPOSITORY=owner/private-repo FORGE_ACCEPTANCE_REQUIRE_GITHUB_APP=true pnpm acceptance:cloud`;
6. capture workflow IDs, workspace state transitions, screenshot artifact hash and teardown evidence;
7. verify the preview and capability fail after destruction;
8. record the deployment date, Worker version, Sandbox SDK version and Cloudflare account in the PR evidence.

## Private GitHub App access

This Forge instance is a private pilot: keep the GitHub App **private**. Only
the Forge owner installs it and selects the repositories it may access. GitHub
intentionally returns a 404-style denial when a collaborator opens a private
App installation URL; Forge now intercepts that route with an explanation
instead of sending collaborators into that dead end.

To add a trusted collaborator:

1. Invite their **GitHub username** to the repository in GitHub. An email such
   as `james.coy.design@gmail.com` can receive GitHub's invitation, but Forge
   cannot grant access from an email alone—the person must accept the invitation
   and sign in to Forge with their GitHub account.
2. They sign in to Forge and choose **Request access**.
3. The owner approves the pending request in the Forge dashboard. Approval
   places that user's audited Forge identity in the owner's existing project,
   so the already-installed, selected repositories become available without
   any public App installation page.
4. The owner uses **Reconnect GitHub** after changing the App's repository
   selection. Collaborators never use the private App install/reconnect routes.

## Incident handling

1. Check `/health`, Worker errors, Workflow failures, Durable Object state and Sandbox provider status.
2. Locate by trace ID, operation ID and workspace ID; never expose raw provider IDs in user communication.
3. For a stuck workspace, revoke previews, stop processes, persist redacted diagnostics, then destroy it. Recovery materializes the GitHub branch in a fresh executor.
4. For GitHub authorization changes, revoke capabilities immediately and reconcile installations.
5. Never retrieve secrets from logs. Rotate signing keys and invalidate capabilities if leakage is suspected.
