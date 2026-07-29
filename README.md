# Forge

**A remote development computer for AI coding agents — over MCP.**

Forge gives ChatGPT, Claude, and any MCP-compatible client a real, isolated
Linux computer: a cloned repository, a terminal, a browser, Git, and
approval-gated draft PRs. The model brings the reasoning; Forge brings the
machine. It runs on Cloudflare's edge, so the compute is cheap and always on.

## Why it exists

- **Rent the model's quota, not the compute.** Drive Forge from whichever chat
  app has generous limits (ChatGPT's are famously roomy) and get a full dev
  environment for near-free — no local setup, no tight sandbox.
- **Code from your phone.** The whole loop — read, edit, run, test, review,
  open a PR — happens on the server. Your device is just the remote control.
- **Cheapest capable runtime, automatically.** Reviewing a deployed URL never
  starts a container; durable tasks and repo/diff inspection stay
  container-free; a full workspace spins up only when execution is needed.

Forge is not an agent framework, an IDE, or an unrestricted shell. It exposes
**bounded** capabilities through MCP, keeping provider credentials and approval
gates in front of anything that reaches the outside world.

## Quickstart

Forge is a hosted MCP connector. Add it to your client and sign in with GitHub:

- **ChatGPT** (Apps SDK / connectors) or **Claude** (Connectors) → add the
  Forge MCP server URL, complete the GitHub OAuth flow, and grant the Forge
  GitHub App access to the repositories you want.
- Then just ask: *"Review https://example.com with Parallax"*, or *"Start a
  task on owner/repo to fix X, then open a draft PR."*

Self-hosting and local development are covered in
[`docs/self-host.md`](docs/self-host.md) and
[`docs/operations.md`](docs/operations.md).

## The tools at a glance

Cheap, container-free tools first — Forge answers as much as possible before
ever starting a workspace. Full reference: [`docs/tools.md`](docs/tools.md).

| Group | Tools | Container? |
| --- | --- | --- |
| Discover & observe | `forge_capabilities`, `forge_observer_*`, `forge_repository_list` | no |
| Durable tasks | `forge_task_create` / `_get` / `_list` / `_update` | no |
| Branch & workspace | `forge_start`, `forge_workspace_*`, `forge_operation_get` | create only |
| Read & edit | `forge_files_list`, `forge_files_read`, `forge_edit`, context/diff tools | reads: no; shell fallback: yes |
| Shell & processes | `forge_shell`, `forge_process_*`, `forge_deps_install` | yes |
| GitHub review | `forge_pr`, `forge_access`, `forge_history`, `forge_branches`, `forge_merge` | no |
| Preview & artifacts | `forge_review`, `forge_preview*`, `forge_artifact_*` | mixed |
| Deployment & secrets | `forge_cloudflare_deploy`, `forge_secret_*` | mixed |

Forge is remote-first. `forge_edit` commits directly to the selected
`forge/*` branch through the GitHub API and returns the remote commit URL; there
is no separate push step. Raw `git push` through `forge_shell` is refused
because it bypasses Forge's branch, concurrency, and durability checks. Use
`forge_merge` to open the review path and return the human approval link.

Workspace creation returns its `workspace_id` and operation handle within the
host request budget; readiness may still be `provisioning`. Pass that id as the
`workspace` value to `forge_workspace_get` instead of starting another one. Managed
process waits are likewise bounded to one host-safe observation; a timeout does
not stop the process.

## Parallax

Parallax is Forge's review discipline: define the **audiences**, **missions**,
and **readiness** a change must satisfy, capture real **evidence** (screenshots,
accessibility structure), and report honest **limitations** — never claim a
journey passed unless its steps were actually executed. See
[`docs/architecture/parallax.md`](docs/architecture/parallax.md).

## Documentation

Start at [`docs/README.md`](docs/README.md). The essentials:

- [Architecture](docs/architecture.md) — how a request becomes a workspace
- [Tool reference](docs/tools.md) — every tool, verbatim from the source
- [Connectors & setup](docs/connectors.md) — ChatGPT and Claude
- [Operations](docs/operations.md) — deploy, migrations, runbook
- [Security](docs/security/README.md) — approvals, capabilities, tenancy
- [Self-hosting](docs/self-host.md)

Credential profiles are tenant-scoped, encrypted at rest, and provider-backed. See [credential profiles](docs/architecture/credentials.md) before configuring `FORGE_CREDENTIAL_ENCRYPTION_KEY` or migrating an installation.

For the filesystem, Git, checkpoint, export, and runtime guarantees required for long-lived agent work, see the [workspace reliability contract](docs/architecture/reliability.md).

## Repository layout

- `apps/forge-edge-gateway` — HTTP, MCP session, and preview gateway
- `packages/core` — identifiers, state machine, errors, domain records
- `packages/application` — provider-independent use cases
- `packages/mcp-core` — the tool catalog (source of truth for tool names)
- `packages/mcp-adapter-v1` — production MCP SDK wiring
- `packages/{sandbox,browser,git,artifacts}-*` — Cloudflare / self-hosted providers
- `packages/{task-core,insight,evidence,cost,policy,capabilities}` — domain logic
- `migrations/d1` — database schema; `infra/wrangler` — deploy config

Domain packages never import Cloudflare, GitHub, MCP, or UI types — those live
behind adapters.

## Develop

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check          # boundaries + typecheck + tests + schemas
pnpm dev            # local worker (requires Docker for the local sandbox)
```

## Status

The Forge Cloud private pilot is deployed at `https://forge.timcoy.uk` with D1,
R2, Durable Objects, Workflows, Browser Run, the smallest `basic` Sandbox
profile, GitHub-backed OAuth and remote MCP. The workers.dev hostname remains
available for existing tokens and preview capabilities. The `forge-mcp-cloud`
GitHub App authorizes selected repositories. Private clone uses a short-lived
Forge credential-proxy capability; branch pushes and draft PR creation require
a separate browser approval. `pnpm run deploy` applies pending D1 migrations,
then deploys the production Worker from `infra/wrangler/forge.jsonc`.
