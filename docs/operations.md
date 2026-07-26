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

Forge has one deployable environment, defined by `infra/wrangler/forge.jsonc`.

```bash
pnpm run deploy
```

**Deploy applies D1 migrations first.** `migrations/d1/` (`0001`…`0011` today)
must apply in strict numeric sequence before the Worker goes live; CI checks
migration sequencing.

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

## Cloudflare bindings

See [architecture.md](architecture.md#cloudflare-bindings-infrawranglerforgejsonc)
for the full binding list (D1, R2, Durable Objects, Workflows, Containers,
Browser Run, Workers AI).

## Provisioning watchdog

A provision Workflow can die or time out mid-run (evicted before its catch
runs), leaving a workspace stuck in a non-terminal provisioning state forever
— never `failed`, never past its idle TTL — which leaks its D1 capacity slot.
The scheduled cron (`*/5 * * * *`, `infra/wrangler/forge.jsonc`) runs
`reapStuckProvisioning` (`apps/forge-edge-gateway/src/index.ts`), which force-fails
any workspace wedged past `STUCK_PROVISION_MS` via the coordinator's
`markProvisioningExhausted` path and releases its slot. The same cron also
drives a global idle-workspace reaper independent of new workspace creation.
Both are best-effort: one failure never aborts the rest of the sweep.

## Bootstrap and lockfile drift

Workspace bootstrap (dependency install after clone) tolerates lockfile drift
— e.g. a `--frozen-lockfile` mismatch — instead of failing the whole workspace
outright, so a repo with a slightly stale lockfile still becomes usable
(`packages/core/src/workspace.ts`).

## Per-repo dependency cache

`deps-cache` (`apps/forge-edge-gateway/src/deps-cache.ts`) caches
`node_modules` in R2 per repository, keyed by content
(`tenantId|repoSlug|runtime|lockfileHash`), not by workspace — so the first
workspace ever created for a known repo/lockfile can still restore from cache
instead of a cold install. It shares the `FORGE_SNAPSHOT_ENABLED` flag with
workspace snapshots and is best-effort throughout. The cache key is
**tenant-scoped by design**: two tenants that clone the same public repo at
the same lockfile never share a cached tree, because `node_modules` contains
executable code and a shared cache would let one tenant's poisoned install run
inside another tenant's workspace.

## Cost

Target: below roughly USD 10/month for one heavy personal user, tracked via
`UsageCounters` (workspace active/idle ms, browser session ms, browser
captures, dependency installs, builds, command count, stored artifact bytes).
`budgetPosition(usage)` estimates monthly USD:

| Level | Estimate | Response |
| --- | --- | --- |
| ok | < $5 | none |
| warning | ≥ $5 | surface budget on responses |
| strong-warning | ≥ $8 | surface prominently, prefer container-free actions |
| hard | ≥ $10 | refuse new cloud workspaces; cleanup, metadata, summaries and compute-free Git stay available |

Keep costs low: reuse one workspace per coherent task; workspaces idle-sleep
after 90s; destroy on durable completion; prefer `forge_review` (no
container) for already-deployed URLs; capture browser evidence only when
deliberate.

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
3. For a stuck workspace: revoke previews, stop processes, persist redacted
   diagnostics, then destroy or snapshot per policy.
4. For a GitHub App authorization change: revoke capabilities immediately and
   reconcile installations.
5. Never retrieve secrets from logs. Rotate signing keys and invalidate
   capabilities if leakage is suspected.

## Self-hosted compute (Mac mini / node agent)

`packages/sandbox-selfhosted` is a real, shipped provider: Forge health-checks
a self-hosted compute agent and falls back to the Cloudflare Sandbox provider
if it's unavailable or out of capacity — transparent to the MCP caller. The
reference agent lives in `self-host/forge-node-agent` (`server.mjs`, plus a
`launchd` plist for always-on macOS use). It uses the **same model as Forge
Cloud** — every workspace is a Docker container, run hardened by default
(non-root, all Linux capabilities dropped, no privilege escalation, no host
mounts, memory/CPU/pid limits) — so agent-authored code stays isolated from
the host machine. Quick start:

```bash
cd self-host/forge-node-agent
brew install colima docker node        # Docker engine (Colima) + CLI + Node
colima start --cpu 4 --memory 8 --disk 60
npm install
docker build -f Dockerfile.workspace -t forge-workspace:latest .
FORGE_AGENT_TOKEN=$(openssl rand -hex 32) npm run selftest   # must exit 0
FORGE_AGENT_TOKEN=xxx npm start                              # listens on :8787
```

It implements the same primitives as the cloud path — sandbox
create/exec/suspend/resume/destroy, file read/write/patch/tree, process
start/get/logs/stop, preview expose/revoke and proxy, and browser
capture/screenshot/accessibility/act. Snapshots are not implemented on this
provider (return `501`). See [self-host.md](self-host.md) for the full guide:
always-on setup, tunnels, pre-cloned repos, concurrency, and taking over a
workspace.
