# Forge

**A remote development computer for AI coding agents — over MCP.**

Forge gives ChatGPT, Claude, and any MCP-compatible client a GitHub-native
coding control plane plus an isolated Linux executor when code actually needs
to run. The model brings the reasoning; Forge brings guarded repository tools
and ephemeral compute on demand.

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

Recipes for planning, UI iteration, bug fixes, and resuming a compressed
ChatGPT session: [`docs/mcp/project-workflows.md`](docs/mcp/project-workflows.md).

Optional self-hosted browser evidence and local development are covered in
[`docs/self-host.md`](docs/self-host.md) and
[`docs/operations.md`](docs/operations.md).

## The tools at a glance

Cheap, container-free tools first — Forge answers as much as possible before
ever starting a workspace. Full reference: [`docs/tools.md`](docs/tools.md).

| Group | Tools | Container? |
| --- | --- | --- |
| Discover & observe | `forge_capabilities`, `forge_observer_*`, `forge_repository_list` | no |
| Durable tasks | `forge_task_create` / `_get` / `_list` / `_update` | no |
| Branch & workspace | `forge_start`, `forge_workspace_*`, `forge_operation_get` | no; executor is lazy |
| Read & edit | `forge_files_list`, `forge_files_read`, `forge_edit`, context/diff tools | no |
| Shell & processes | `forge_shell`, `forge_process_*`, `forge_deps_install` | yes |
| GitHub review | `forge_pr`, `forge_access`, `forge_history`, `forge_branches`, `forge_merge` | no |
| Preview & artifacts | `forge_review`, `forge_preview*`, `forge_artifact_*` | mixed |
| Deployment & secrets | `forge_deploy` (agent `map_env` from attached secrets), `forge_secret_*` | mixed |

GitHub's API is the sole durable repository plane: file CRUD, branch reads and
writes, diffs, commits, history, and pull requests all operate on GitHub.
`forge_edit` is the only file-writing/deleting tool and commits directly to the
selected `forge/*` branch. Raw `git push` through `forge_shell` is refused. Use
`forge_merge` to open the review path and return the human approval link.

Workspace creation returns a lightweight control-plane session immediately; it
does not provision a container. The first shell, install, build, test, dev,
preview, or deploy call allocates an ephemeral executor. Files created or
modified by commands remain executor-only, report `remote_persisted:false`, and
are discarded with that executor unless the wanted change is explicitly
recreated through `forge_edit`.

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
- [Self-hosted browser](docs/self-host.md)

Vault secrets are tenant-scoped and encrypted at rest. See [credentials and secrets](docs/architecture/credentials.md) before configuring `FORGE_CREDENTIAL_ENCRYPTION_KEY` or migrating an installation.

For the GitHub durability and ephemeral-executor guarantees, see the [workspace reliability contract](docs/architecture/reliability.md).

## Repository layout

- `apps/forge-edge-gateway` — HTTP, MCP session, and preview gateway
- `packages/core` — identifiers, state machine, errors, domain records
- `packages/application` — provider-independent use cases
- `packages/mcp-core` — the tool catalog (source of truth for tool names)
- `packages/mcp-adapter-v1` — production MCP SDK wiring
- `packages/{sandbox,browser,git,artifacts}-*` — Cloudflare providers plus the optional self-hosted browser
- `packages/{task-core,insight,policy,capabilities,credentials,events,audit}` — domain logic
- `migrations/d1` — database schema; `infra/wrangler` — deploy config

Domain packages never import Cloudflare, GitHub, MCP, or UI types — those live
behind adapters.

## Develop

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check          # boundaries + wiring + typecheck + tests + schemas
pnpm dev            # local worker (requires Docker for the local sandbox)
```

## Status

The Forge Cloud private pilot is deployed at `https://forge.timcoy.uk` with D1,
R2, Durable Objects, Workflows, Browser Run, the smallest `basic` Sandbox
profile, GitHub-backed OAuth and remote MCP. The workers.dev hostname remains
available for existing tokens and preview capabilities. The `forge-mcp-cloud`
GitHub App authorizes selected repositories. Repository CRUD, diffs, commits,
branches, and PRs use the GitHub API; executors are allocated only for runtime
work. Approval-gated PR mutations and deployments use the hosted approval
flow. `pnpm run deploy` applies pending D1 migrations, then deploys the
production Worker from `infra/wrangler/forge.jsonc`.
