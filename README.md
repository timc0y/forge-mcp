# Forge MCP

**A Cloudflare-native remote development runtime for AI coding agents.**

Forge gives any compatible AI agent a secure remote development computer connected to a real repository. The agent supplies reasoning; Forge supplies the workspace, Linux runtime, files, commands, browser evidence, Git state, policy and audit trail.

Forge is not an agent framework, IDE, CI product, or unrestricted shell service. It exposes bounded capabilities through MCP and a direct API while keeping provider credentials and Cloudflare implementation details behind adapters.

## Current milestone

This repository implements the Phase 0 foundation and the Phase 1 vertical-slice path:

```text
authenticated MCP request
  -> Workspace Coordinator Durable Object
  -> CloudflareSandboxProvider
  -> public Git clone
  -> project detection and bootstrap
  -> file read/tree/patch
  -> bounded command and process execution
  -> private preview capability
  -> Browser Run screenshot
  -> Git status/diff
  -> workspace destruction
```

The Cloudflare Sandbox SDK is isolated in `packages/sandbox-cloudflare`. Domain packages do not import Cloudflare, GitHub, MCP SDK or UI framework types.

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

The checked-in code is designed to type-check against pinned package versions and includes local unit and contract tests. A real shared Cloudflare environment still requires account bindings, OAuth registration, a Browser Run binding, D1/R2 resources and a GitHub App installation. The deployment runbook records the exact validation steps and does not claim those external resources exist until evidence is captured.
