# Forge

**A GitHub workspace for ordinary AI chats — over MCP.**

Forge lets an ordinary ChatGPT or Claude conversation browse your authorized
repositories, read and make small focused edits, run commands, deploy through
saved environments, and inspect websites at responsive breakpoints. The chat
brings the reasoning; Forge provides guarded GitHub access and ephemeral
compute only when it is needed.

## Why it exists

- **Stay in chat.** Make focused repository and design changes without moving
  the conversation into an IDE or autonomous coding agent.
- **Code from your phone.** The whole loop — read, edit, run, test, review,
  open a PR — happens on the server. Your device is just the remote control.
- **Cheapest capable runtime, automatically.** Reviewing a deployed URL never
  starts a container; durable tasks and repo/diff inspection stay
  container-free; a full workspace spins up only when execution is needed.

Forge is not an agent framework, an IDE, or an unrestricted shell. It exposes
eleven bounded, user-level capabilities through MCP, keeping provider credentials
and approval gates outside model context.

## Quickstart

Forge is a hosted MCP connector. Add it to your client and sign in with GitHub:

- **ChatGPT** (Apps SDK / connectors) or **Claude** (Connectors) → add the
  Forge URL ending in `/mcp`, complete the GitHub OAuth flow, and grant the
  Forge GitHub App access to the repositories you want.
- Then ask naturally: *"Improve the design direction in our docs"*, *"Change
  this component and show it on phone and desktop"*, or *"Run the checks and
  deploy this branch to staging."*

Optional self-hosted browser evidence and local development are covered in
[`docs/self-host.md`](docs/self-host.md) and
[`docs/operations.md`](docs/operations.md).

## The tools at a glance

Eleven user-level tools cover the direct-chat workflow. Full reference:
[`docs/tools.md`](docs/tools.md).

| Outcome | Tools |
| --- | --- |
| Find and understand code | `forge_repositories`, `forge_search`, `forge_read` |
| Make a focused change | `forge_edit` |
| Run and inspect | `forge_run`, `forge_screenshot`, `forge_status` |
| Release | `forge_environments`, `forge_deploy`, `forge_submit`, `forge_merge` |

GitHub's API is the sole durable repository plane. `forge_edit` commits directly
to a Forge branch. `forge_run` executes against that branch but cannot save
repository changes. `forge_submit` prepares the durable change for human review.
`forge_merge` queues an existing pull request for human approval, then Forge
rereads and verifies the merge without another chat call.

Commands, branch previews, and deployments allocate ephemeral compute lazily.
Workspace, process, dependency, and cleanup state remain Forge implementation
details rather than concepts the chat must carry between turns.

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
