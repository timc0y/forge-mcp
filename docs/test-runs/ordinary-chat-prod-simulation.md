# Ordinary-chat production simulation

Purpose: exercise Forge from a constrained, non-agentic ChatGPT-style flow.

## Test contract

- Production MCP endpoint.
- Dedicated `forge/chat-*` branch.
- GitHub is the durability boundary.
- No workspace, process, preview, or operation IDs are retained.
- Each tool result must be useful if the conversation stops immediately.

## Initial state

The run begins by discovering authorized repositories, searching and reading the Forge docs, then making this document durable before verification.

## Observed production trace

- `forge_repositories`: pass; returned 24 authorized repositories.
- `forge_search`: pass for `forge.json`; an exact multi-word phrase returned no matches, so the search query needs to stay token-oriented.
- `forge_read`: pass; read the tool reference, workflow examples, runtime architecture, and this file from GitHub.
- `forge_edit`: pass; created this branch and committed the document remotely, then passed a fragment edit.
- `forge_run`: fail; first executor allocation returned private workspace/operation choreography and named the removed `forge_workspace_get` action instead of absorbing startup.
- `forge_screenshot` for this branch: fail; it returned the same private startup choreography, and repeating the public action created another ephemeral workspace rather than recovering semantically.
- `forge_screenshot` for `https://forge.timcoy.uk`: pass; returned phone, tablet, and desktop images inline in one response, with no container.
- `forge_environments`: pass; returned an empty environment list without secret values.
- `forge_deploy`: fail closed as expected; no approved deployment environment named `production` exists for this repository.
- `forge_status`: pass; branch-addressed recovery returned no active operation and required no opaque identifier.
- `forge_submit`: pending until this trace is committed.

No opaque workspace, process, operation, artifact, or signed gallery identifiers are recorded here.
