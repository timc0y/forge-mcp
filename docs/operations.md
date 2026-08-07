# Operations Guide

## Pre-deployment Validation
```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm cf:typegen
pnpm --filter @forge/edge-gateway exec wrangler deploy --dry-run --config ../../infra/wrangler/forge.jsonc
```

## Deployment Commands
```bash
pnpm wrangler login          # Re-auth Cloudflare
pnpm run deploy              # Deploy Worker + rebuild Sandbox container image (needs Docker)
pnpm run deploy:worker       # Deploy Worker only; applies D1 migrations, skips Docker build
```
*   **Live Console**: Owners can view live logs and tools at [`/app/live`](https://forge.timcoy.uk/app/live) or via observer tools (`forge_observer_*`).
*   **Database Migrations**: Stored in `migrations/d1/`. Applied automatically in sequential order during deployment. Database rollbacks are forbidden in production unless explicitly approved.

## Deployment Checklist
1. Verify D1 database and R2 bucket exist.
2. Set Worker secrets: `FORGE_CAPABILITY_SIGNING_KEY`, `FORGE_SESSION_SIGNING_KEY`, `FORGE_DEV_AUTH_TOKEN`, `FORGE_INTERNAL_PREVIEW_KEY`.
3. Deploy Worker and verify `/health` and `/ready` endpoints.
4. Execute E2E validation: create workspace -> edit file -> preview -> screenshot -> destroy.
5. Confirm token-revocation after teardown.

## Watchdogs & Cleanup

*   **Provision Watchdog**: Stuck `provisioning` or `bootstrapping` states that leak D1 capacity are swept by a cron task (`*/5 * * * *`). It triggers `reapStuckProvisioning` to force-terminate runs exceeding `STUCK_PROVISION_MS` and free slots.
*   **Workspace Cleanup**: `forge_workspace_destroy` revokes route previews, kills processes, and marks database records deleted. Scheduled reaper deletes orphaned containers and expired previews.

## Incident Management
1. Check `/health`, Worker exceptions, DO states, and Sandbox provider status.
2. Query using trace IDs, operation IDs, and workspace IDs.
3. Distinguish lazy `requested` (idle, no container yet) from hung provisioning states before terminating.
4. Stuck session recovery: revoke previews -> terminate processes -> store diagnostics -> run destroy.
5. In case of secret leaks: rotate signing keys and invalidate tokens.

## Self-Hosted Browser Agent (`packages/browser-selfhosted`)
Optional browser agent running on custom compute (SSRF protected). Falls back to Cloudflare Browser Run if offline.
```bash
cd self-host/forge-node-agent
brew install node && npm install
npx playwright install chromium
FORGE_AGENT_TOKEN=$(openssl rand -hex 32) npm run selftest
FORGE_AGENT_TOKEN=xxx npm start
```
Configure edge Worker:
```bash
wrangler secret put FORGE_SELFHOST_TOKEN
# Environment: FORGE_SELFHOST_ENABLED=true, FORGE_SELFHOST_URL=https://<agent-origin>
```
