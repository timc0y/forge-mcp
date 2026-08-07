# Parallax Integration

Parallax is Forge's 1st-party client (not the execution platform), interacting via public MCP contract or Cloudflare service bindings into application services.

## Boundaries & Capabilities

| Domain | Mechanism | Behavior & Constraints |
| --- | --- | --- |
| **Review Semantics** | `forge_review` | Captures deployed URL screenshots without executors. Evidence provider alongside host browser, Chrome, and repo Playwright. |
| **Repo Builds** | Ephemeral Executor | Allocated only when source must be installed, built, tested, or served. |
| **Repo Edits** | `forge_edit` | Routed via GitHub integration. |
| **Native Optimizations** | Service Binding | Optimizes identity propagation, event delivery, preview embedding, and approvals. Policy/workspace logic remains in Forge. |
| **Security Boundaries** | Scope Restrictions | Receives workspace-scoped capabilities. Never receives GitHub tokens, executor credentials, or unrestricted internal bindings. |

## Specialist Skill Integrations

| Skill | Forge Tools & Workflow | Capability Flags | Dependencies |
| --- | --- | --- | --- |
| `website-qa` | Remote screenshots & a11y structure via `forge_review`. Uses `forge-evidence` fallback if local capture unavailable (retains packet, names missing coverage). Imports `audit-manifest.json`. | `capabilities.websiteQaRunner: false` (prevents mistaking remote capture for full responsive, interaction, link, console/network, regression, cross-browser sweep). Boolean fields define machine-readable boundaries. | Standalone. Zero Parallax/Forge runtime dependencies. |
| `figma-parity` | Rendered output via `forge_review` or `forge_preview`. Skill fetches Figma nodes independently for comparison. | `figmaSourceAccess: false`, `figmaParityComparison: false`. Retains artifact IDs/hashes in parity manifest. | Standalone. Zero Parallax/Forge runtime dependencies. |
