# Forge documentation

> Forge gives compatible AI clients a safe remote development computer. The
> client supplies reasoning; Forge supplies repository state, execution,
> previews, browser evidence, Git operations and durable task context.

## Map

- [`RECONCILIATION.md`](./RECONCILIATION.md) — current branch/PR/doc state.
- `product/` and [`PRODUCT-PLAN.md`](./PRODUCT-PLAN.md) — what Forge is, the
  target user, product boundaries, terminology and supported workflows.
- `architecture/` — the architecture as implemented: packages, Cloudflare
  bindings, workspace lifecycle, preview routing, browser, Git/credential flow,
  persistence and evidence format.
- `plans/` — active implementation programmes only.
- `operations/` — deployment, production config, budget/cleanup runbooks,
  incident response, GitHub App and Cloudflare operations, acceptance testing.
- `security/` — threat model, capability tokens, OAuth, Git credentials, shell
  policy, preview access, secret handling, approval boundaries.
- `research/` — dated investigations, rejected alternatives and experimental
  Cloudflare features (gated by `feature-flags.json`).
- `mcp/` — tool catalog, client compatibility and error codes.
- `adr/` — architecture decision records.

## Terminology

**Task** a durable coding-session record · **Workspace** a temporary Linux
execution environment · **Process** a command in a workspace · **Preview** a
private live URL for a process · **Browser session** an interactive browser
visiting a preview · **Evidence** a stored, verifiable output · **Artifact** a
stored binary/large object referenced by id · **Approval** an explicit user
authorization.

"Preview" never means screenshot; "workspace" never means task; "browser" never
means application preview.
