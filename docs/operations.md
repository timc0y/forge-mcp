# Operations

## Pre-deployment validation

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm cf:typegen
pnpm --filter @forge/edge-gateway exec wrangler deploy --dry-run \
  --config ../../infra/wrangler/forge.jsonc
```

A dry run proves bundling and configuration shape only — not Sandbox
allocation, Browser Run, OAuth, D1, R2, Workflows, or preview routing.

## Deploy

Forge has one production environment plus a named development environment,
defined by `infra/wrangler/forge.jsonc`.

Wrangler is a dev dependency — there is no global `wrangler` on `PATH` unless you
install it yourself. Use the repo scripts:

```bash
pnpm wrangler login          # refresh Cloudflare OAuth
pnpm run deploy              # Worker + Sandbox container image (needs Docker)
pnpm run deploy:worker       # Worker only; still migrates D1, skips image build/push
```

**Live operator view:** signed-in owners open [`/app/live`](https://forge.timcoy.uk/app/live)
for a read-only window: workspace list, D1 MCP tool trail (complete activity with
redacted payloads), process log tails, and SSE updates (~4s). Same trail via
`forge_observer_activity`. Observer MCP tools:
`forge_observer_workspaces`, `forge_observer_workspace`, `forge_observer_activity`.
Deploy with `pnpm run deploy:worker` to avoid disturbing running sandboxes. It
still applies pending D1 migrations before publishing the Worker.

**Docker is required for `pnpm run deploy`.** Wrangler builds `infra/wrangler`
`containers[].image` (`../../Dockerfile`) locally before upload. Start Docker
Desktop (`open -a Docker`) or use `deploy:worker` when you changed only Worker
code and do not need a new Sandbox image.

**Deploy applies D1 migrations first.** `migrations/d1/` (`0001`…`0032` today)
must apply in strict numeric sequence before the Worker goes live; CI checks
migration sequencing. Every migration must remain compatible with both the
currently deployed Worker and the release being published. If the Worker deploy
fails after migration, stop retries that could compound state, inspect the
applied migration state, then roll forward a compatible Worker. Do not roll
back production schema except through an explicitly approved restore plan.

Local iteration uses the same config with an auth-relaxed identity:

```bash
pnpm dev
```

`pnpm dev` requires Docker for local Sandbox development. `LocalDockerSandboxProvider`
is used only by deterministic provider contract tests and must never point at
production.

Deployment checklist:

1. Confirm the D1 database (`forge-production`) and R2 bucket
   (`forge-production-artifacts`) exist and match the IDs in `forge.jsonc`.
2. Set Worker secrets: `FORGE_CAPABILITY_SIGNING_KEY` (required),
   `FORGE_SESSION_SIGNING_KEY` (optional, see [security.md](security.md)),
   `FORGE_DEV_AUTH_TOKEN`, `FORGE_INTERNAL_PREVIEW_KEY`.
3. Deploy the Worker; migrations apply automatically as part of `pnpm run deploy`.
4. Check `/health`, `/ready`, and the RFC 9728 OAuth protected-resource
   metadata endpoint.
5. Run an end-to-end acceptance pass through a real MCP client (workspace
   create → file edit → preview → screenshot → teardown).
6. Verify previews and capabilities fail after workspace destruction.
7. Record the deployment date, Worker version, Sandbox SDK version, and
   Cloudflare account in the PR evidence.

## Private GitHub App access

This private pilot uses an owner-managed GitHub App. The owner installs or
reconnects the App and selects repositories; a collaborator does not use an App
installation URL. To add a collaborator, invite their GitHub username to the
repository, have them sign in to Forge and choose **Request access**, then
approve that request in Forge. Reconnect the App after changing its repository
selection.

## Cloudflare bindings

See [architecture.md](architecture.md#cloudflare-bindings-infrawranglerforgejsonc)
for the full binding list (D1, R2, Durable Objects, Workflows, Containers,
Browser Run, Workers AI).

## Provisioning watchdog

A provision Workflow can die or time out mid-run (evicted before its catch
runs), leaving a workspace stuck in `provisioning` or `bootstrapping` forever
— never `failed`, never past its idle TTL — which leaks its D1 capacity slot.
The scheduled cron (`*/5 * * * *`, `infra/wrangler/forge.jsonc`) runs
`reapStuckProvisioning` (`apps/forge-edge-gateway/src/index.ts`), which force-fails
any workspace wedged in those active provision states past `STUCK_PROVISION_MS`
via the coordinator's `markProvisioningExhausted` path and releases its slot.
Lazy `requested` sessions (GitHub branch ready, executor not yet started) are
not treated as stuck; they use the normal idle TTL. The same cron also drives a
global idle-workspace reaper independent of new workspace creation. Both are
best-effort: one failure never aborts the rest of the sweep.

## Bootstrap and lockfile drift

Workspace bootstrap (dependency install after clone) tolerates lockfile drift
— e.g. a `--frozen-lockfile` mismatch — instead of failing the whole workspace
outright, so a repo with a slightly stale lockfile still becomes usable
(`packages/core/src/workspace.ts`).

## Cost

Automated metering and hard budget enforcement are proposed, not deployed: the
`UsageCounters` / `budgetPosition` model belongs to
[cost-controls.md](plans/cost-controls.md) and `@forge/cost` is not a current
package. Keep costs low operationally: reuse one workspace per coherent task,
allow idle instances to sleep, destroy on durable completion, prefer
`forge_review` (no container) for already-deployed URLs, and capture browser
evidence only when deliberate.

## Workspace cleanup

`forge_workspace_destroy` revokes preview routes and capabilities, stops
processes, destroys the sandbox, persists selected artifacts, and marks the
workspace destroyed in D1. The scheduled reaper independently finds expired
previews, stale ready workspaces, failed lifecycle workflows, and orphaned
provider container instances (an orphan can result from a provision timeout)
and cleans them up.

## Incident handling

1. Check `/health`, Worker errors, Workflow failures, Durable Object state,
   and Sandbox provider status.
2. Locate by trace ID, operation ID, and workspace ID; never expose raw
   provider IDs in user-facing communication.
3. Distinguish healthy lazy `requested` (no executor yet — continue with
   GitHub tools) from wedged `provisioning` / `bootstrapping` (stuck-provision
   watchdog) before force-failing a session. See
   [EasyRoads requested-state autopsy](reviews/2026-08-02-easyroads-requested-state-autopsy.md).
4. For a stuck workspace: revoke previews, stop processes, persist redacted
   diagnostics, then destroy; a later execution materializes a fresh checkout
   from GitHub.
5. For a GitHub App authorization change: revoke capabilities immediately and
   reconcile installations.
6. Never retrieve secrets from logs. Rotate signing keys and invalidate
   capabilities if leakage is suspected.

## Optional self-hosted browser

`packages/browser-selfhosted` is an optional browser-evidence provider. Forge
health-checks a local Chromium agent and falls back to Cloudflare Browser Run
when it is unavailable. It is not a sandbox provider: repository commands still
run only in Cloudflare Sandbox, and durable file operations still use GitHub.

The reference browser agent lives in `self-host/forge-node-agent`:

```bash
cd self-host/forge-node-agent
brew install node
npm install
npx playwright install chromium
FORGE_AGENT_TOKEN=$(openssl rand -hex 32) npm run selftest
FORGE_AGENT_TOKEN=xxx npm start
```

See [self-host.md](self-host.md) for tunnel setup and the exact browser-only
surface.
