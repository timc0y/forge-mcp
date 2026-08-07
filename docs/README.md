# Forge Documentation

Forge provides a secure, durable, remote development runtime for coding agents.

## Directory Index
*   [Architecture](./architecture.md): Request routing, workspace lifecycle, bindings.
*   [Tool Reference](./tools.md): Reference details for the 47 MCP tools.
*   [Connectors & Setup](./connectors.md): Client setup (ChatGPT/Claude) and OAuth.
*   [Operations](./operations.md): Verification, deployment, watchdogs, cleanup.
*   [Security](./security/README.md): Threat models, capabilities, approvals.
*   [Self-Hosted Browser](./self-host.md): Optional local Chromium agent.
*   [Parallax Contract](./architecture/parallax.md): Verification contract schema.

## Vocabulary
*   **Task**: Durable coding-session state.
*   **Workspace**: Ephemeral execution environment (Durable Object).
*   **Process**: Managed command inside workspace.
*   **Preview**: Secure URL exposing a process.
*   **Evidence**: Verified review data.
*   **Artifact**: Large objects/screenshots stored in R2.
*   **Capability**: Signed action grant.
*   **Approval**: Explicit human authorization.

## Deep Dives
*   [`architecture/`](./architecture/): Per-subsystem logic.
*   [`security/`](./security/): Boundaries, network policies, threats.
*   [`operations/`](./operations/): Incidents, upgrades, cleanup cron.
*   [`mcp/`](./mcp/): Client compatibility, project workflows.
*   [`adr/`](./adr/): Architecture Decision Records.

## Roadmap & Research
*   [`plans/`](./plans/), [PRODUCT-PLAN.md](./PRODUCT-PLAN.md): Roadmaps.
*   [`research/`](./research/): Dated investigations.
*   [ARCHIVE_INDEX.md](./ARCHIVE_INDEX.md): Consolidated index of completed milestones, old plans, and resolved incident autopsies.
