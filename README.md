# Forge MCP

**A Cloudflare-native remote development runtime for AI coding agents.**

Forge gives any compatible AI agent a secure remote development computer connected to a real repository. The agent supplies reasoning; Forge supplies the workspace, Linux runtime, files, commands, browser evidence, Git state, policy and audit trail.

Forge is not an agent framework, IDE, CI product, or unrestricted shell service. It exposes bounded capabilities through MCP and a direct API while keeping provider credentials and Cloudflare implementation details behind adapters.

## Current product

Forge is built for Parallax first. The complete product shape—Forge Local, self-hosted Forge and hosted Forge Cloud—is defined in [the product plan](docs/PRODUCT-PLAN.md).

The current deployable vertical path is:

```text
authenticated MCP request
  -> GitHub-backed Forge account and repository authorization
  -> Workspace Coordinator Durable Object
  -> CloudflareSandboxProvider
  -> public or private Git clone through a scoped credential proxy
  -> project detection and bootstrap
  -> file read/tree/patch
  -> bounded command and process execution
  -> private preview capability
  -> Browser Run screenshot
  -> Git status/diff, Forge branch, bot commit and approval-gated draft PR
  -> workspace destruction
```

For an already deployed site, `forge_review` skips the workspace entirely and uses Browser Run Quick Actions to return phone and desktop screenshots directly to the model. Forge Cloud permits two active workspaces globally, uses 90-second idle sleep, and keeps the URL-review path container-free.

Supporting ChatGPT and other MCP Apps hosts receive the optional `ui://forge/workspace-console` interface for repository, workspace, evidence and approval results. Clients without MCP Apps continue to receive the same structured and textual tool output.

The Cloudflare Sandbox SDK is isolated in `packages/sandbox-cloudflare`. Domain packages do not import Cloudflare, GitHub, MCP SDK or UI framework types.

Credential profiles are tenant-scoped, encrypted at rest, and provider-backed. See [credential profiles](docs/architecture/credentials.md) before configuring `FORGE_CREDENTIAL_ENCRYPTION_KEY` or migrating an installation.

## Repository layout

- `apps/forge-edge-gateway` — HTTP, MCP session and preview gateway
- `packages/core` — identifiers, state machine, errors and domain records
- `packages/application` — provider-independent use cases
- `packages/sandbox-core` — stable sandbox contracts
- `packages/sandbox-cloudflare` — `@cloudflare/sandbox` adapter
- `packages/sandbox-local-docker` — local contract-test provider
- `packages/mcp-core` — canonical Forge tool definitions
- `packages/mcp-adapter-v1` — production MCP SDK v1 adapter
- `packages/mcp-adapter-v2-beta` — isolated migration seam, not production
- `packages/policy` — shell, branch, network and approval policy
- `packages/browser-*`, `packages/git-*`, `packages/artifacts-*` — provider boundaries
- `workflows` — durable lifecycle workflow definitions
- `infra/wrangler` — canonical Cloudflare configuration
- `docs/research` — verified dependency and product research

## Commands

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm cf:typegen
pnpm dev
```

`pnpm dev` uses the Cloudflare worker configuration and requires Docker for Sandbox local development. `LocalDockerSandboxProvider` is used by deterministic provider contract tests and must never point at production.

## Security defaults

- no ambient GitHub or production credentials in sandboxes
- separate workspace per security principal unless collaboration is explicit
- explicit sessions with the Sandbox default session disabled
- private previews by default
- no default-branch push
- stable Forge errors rather than raw provider errors
- idempotency keys and expected revisions on mutations
- bounded command output and timeouts
- provider IDs remain internal
- beta and experimental features remain behind adapters and flags

See [system architecture](docs/architecture/system.md), [threat model](docs/security/threat-model.md), and [adoption register](docs/research/adoption-register.md).

## Status

The Forge Cloud private pilot is deployed at `https://forge-edge-gateway.timcoy72.workers.dev` with D1, R2, Durable Objects, Workflows, Browser Run, the smallest `basic` Sandbox profile, GitHub-backed OAuth and remote MCP. The `forge-mcp-cloud` GitHub App authorizes selected repositories. Private clone uses a short-lived Forge credential-proxy capability; branch pushes and draft PR creation require a separate browser approval.
