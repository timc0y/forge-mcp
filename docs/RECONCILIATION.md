# Repository reconciliation

Dated: 2026-07-16

This note records the state of the repository before and during the durable
task-model work, so that no useful research is discarded and `main` stays the
single source of truth.

## Branches and pull requests

| Ref | Classification | Action |
| --- | --- | --- |
| `main` | current | Source of truth. |
| PR #1 `agent/rename-to-forge-mcp` | merged | Delivered the Cloudflare-native pilot (OAuth 2.1 PKCE, Streamable HTTP MCP, sandbox workspaces, preview routing, browser evidence, R2 artifacts). Already merged into `main`; branch may be deleted. |

There are **no open pull requests** and **no unexplained implementation
branches**. The only non-`main` branch is the current working branch for this
change. Nothing needs to be merged to empty the branch list.

## Documentation state

The repository already carries a structured `docs/` tree that substantially
covers the target model. Mapping to the requested structure:

| Requested area | Existing home | Status |
| --- | --- | --- |
| `product/` | `docs/PRODUCT-PLAN.md` | Present; canonical product statement lives here. |
| `architecture/` | `docs/architecture/*` (`system`, `runtime`, `persistence`, `security`, `github`, `mcp`, `workspace-state`, `sequences`, `parallax`) | Present and current. |
| `plans/` | `docs/PLAN-0.5.md`, `docs/plans/*` | Active programmes; `task-memory.md` added by this change. |
| `operations/` | `docs/operations/*` (`runbook`, `workspace-cleanup`, `incident-response`, `provider-upgrade`) | Present. |
| `security/` | `docs/security/*` (`threat-model`, `capability-tokens`, `approval-model`, `trust-boundaries`, `network-policy`) | Present. |
| `research/` | `docs/research/*` (dated Cloudflare investigations, adoption register) | Present; experiments marked with maturity in `feature-flags.json`. |
| ADRs | `docs/adr/000*` | Present. |

No active roadmap lives only in a README or a research note. Historical research
is preserved under `docs/research/` and gated by `feature-flags.json` maturity,
not deleted.

## Runtime state observed

- MCP tool surface (`@forge/mcp-core`) exposed workspace, files, shell, process,
  preview, browser, git and artifact tools, but **no durable task abstraction**.
- Persistence (`@forge/metadata-d1`) covered workspaces only.
- The temporary workspace was the only unit of continuity, so a ChatGPT context
  compression or MCP reconnect lost the coding session.

## Change in this branch

Adds the durable **task** model that sits above the disposable workspace
(`@forge/task-core`, D1 `tasks` table, five `forge_task_*` tools). See
`docs/plans/task-memory.md`. This is additive: no existing tool name, schema or
workspace behaviour changed.
