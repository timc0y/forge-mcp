# Parallax integration

Parallax is Forge's first-party client, not the execution platform. It can use either the public MCP contract or a Cloudflare service binding into the same application services.

Parallax owns review semantics and requires inspected screenshot evidence. Forge is one evidence provider alongside the host's built-in browser, Chrome and repository Playwright. `forge_review` captures deployed URLs without an executor; repository builds allocate an ephemeral executor only when source must be installed, built, tested or served. Repository edits still go through `forge_edit` and GitHub.

The native path may optimize identity propagation, event delivery, preview embedding and approvals, but cannot duplicate policy or workspace logic. Parallax receives workspace-scoped Forge capabilities, never GitHub installation tokens, executor-provider credentials or unrestricted internal bindings.

## Website QA specialist

Parallax may invoke the standalone `website-qa` skill as a deterministic specialist and
import its provider-neutral `audit-manifest.json`. Forge complements that run with remote
screenshots and accessibility structure through `forge_review`. The Forge packet reports
`capabilities.websiteQaRunner: false` so remote capture can never be mistaken for execution
of the full responsive, interaction, link, console/network, regression and cross-browser
sweep. The other boolean capability fields make the reduced boundary machine-readable.
`website-qa` may select this as a `forge-evidence` branch when local capture is unavailable,
but it retains the original Forge packet and names missing coverage. The skill remains
independently runnable and has no Parallax or Forge runtime dependency.

## Figma parity specialist

Parallax may invoke the standalone `figma-parity` skill when a page or component has a
specific Figma source. Forge can provide the rendered half through `forge_review` or
`forge_preview`; the skill independently obtains the Figma nodes and performs the comparison.
Forge packets declare `figmaSourceAccess: false` and `figmaParityComparison: false`, and retain
their artifact IDs and hashes when referenced by the parity manifest. Neither Forge nor
Parallax is a runtime dependency of the skill.
