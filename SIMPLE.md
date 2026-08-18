# Simple profile

## Reality

- Users: ChatGPT and Claude users operating authorised GitHub workspaces from ordinary conversations.
- Operators: repository owners configuring GitHub App access, credentials, ephemeral compute and Cloudflare deployment.
- External consumers: MCP clients, GitHub App installations, workflow definitions and the Forge web/worker surfaces.
- Public contracts: MCP tools, OpenAPI/schema artifacts, capability boundaries, audit events and workflow state transitions.
- Persistent production data: D1 metadata, R2 artifacts, credentials, audit records and saved environment/workflow state.
- Compatibility obligations: preserve authorised repository scope, schema migrations and tool contracts used by existing clients.
- Current scale and failure consequences: remote code execution and repository mutation; boundary failure can expose credentials, alter code or run untrusted workloads.

## Architecture boundary

Forge supplies guarded GitHub access, ephemeral compute and browser evidence. The host chat owns reasoning; Forge is not an autonomous project manager, permanent development machine or product-review authority.

## Deletion proof

- Dead code: `pnpm catalog:measure` and repository searches, with explicit checks for schema-, workflow- and tool-registered entry points.
- Types or compiler: `pnpm typecheck`.
- Behaviour: `pnpm test`, plus focused tool or end-to-end tests for changed capabilities.
- Build: `pnpm check`.
- Public surface: regenerate and compare schemas/OpenAPI, inspect MCP tool registration and run boundary checks.
