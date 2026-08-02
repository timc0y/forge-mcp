# Forge documentation

Forge gives ChatGPT, Claude, and any MCP client a safe remote development
computer. The client supplies reasoning; Forge supplies the repository, runtime,
files, commands, previews, browser evidence, Git operations, and durable task
context.

## Start here

- [Architecture](./architecture.md) — how an MCP request becomes a workspace.
- [Tool reference](./tools.md) — every tool, verbatim from `packages/mcp-core`.
- [Connectors & setup](./connectors.md) — add Forge to ChatGPT or Claude.
- [Operations](./operations.md) — deploy, D1 migrations, config, runbook.
- [Security](./security/README.md) — approvals, capability tokens, tenancy.
- [Self-hosted browser](./self-host.md) — optionally render browser evidence on your own box.
- [Parallax](./architecture/parallax.md) — the review contract and evidence rules.

## Terminology (one word per concept)

**Task** a durable coding-session record · **Workspace** a temporary Linux
execution environment · **Process** a command in a workspace · **Preview** a
private live URL for a process · **Evidence** a stored, verifiable review output
· **Artifact** a stored binary/large object referenced by id · **Capability** a
scoped, short-lived signed token · **Approval** an explicit human authorization.

"Preview" never means screenshot; "workspace" never means task; "browser" never
means application preview.

## Deep dives & reference

- [`architecture/`](./architecture/) — per-subsystem detail (runtime, github,
  persistence, security, sequences, workspace-state).
- [`security/`](./security/) — threat model, capability tokens, network policy,
  trust boundaries, approval model.
- [`operations/`](./operations/) — incident response, provider upgrades,
  workspace cleanup, cost runbook.
- [`mcp/`](./mcp/) — error codes, client compatibility, project workflows,
  the agent execution playbook.
- [`adr/`](./adr/) — architecture decision records.

## Vision & research (not all shipped)

These capture direction and investigation, and may describe features that are
not yet built. Treat them as background, not current behavior.

- [`plans/`](./plans/) and [`PRODUCT-PLAN.md`](./PRODUCT-PLAN.md),
  [`PLAN-0.5.md`](./PLAN-0.5.md),
  [`CHATGPT-FIRST-MASTER-PLAN.md`](./CHATGPT-FIRST-MASTER-PLAN.md) — product and
  roadmap thinking.
- [`research/`](./research/) — dated investigations and rejected alternatives.
- [`RECONCILIATION.md`](./RECONCILIATION.md) — a point-in-time branch/doc audit.
