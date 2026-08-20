# Research Archive

This archive consolidates historical investigations, rejected alternatives, and platform evaluation notes from July 2026.

## Subsystem Research Index
*   [Executor Alternatives](./executor-alternatives-2026-07.md): Analysis of E2B, Modal, Fly, Codespaces, and self-hosted runners.
*   [Adoption Register](./adoption-register.md): Version pins and maturity logs for core platform dependencies.
*   [Progress Potential (Φ-gate)](./progress-potential.md): Lyapunov control-theory model for agent tool-stream gating.

---

## 1. Cloudflare Native Integrations

### Cloudflare Agents (`agents` @ `0.17.3`)
*   **Surface**: `McpAgent` and streamable HTTP server.
*   **Maturity**: Adopted. Handles reconnect and session multiplexing in the Edge Worker (`apps/forge-edge-gateway/src/mcp-session.ts`).
*   **Risk**: Evolving API. Isolated in the session adapter.

### Cloudflare Browser Run (Workers binding @ `5.20260712.1`)
*   **Surface**: `quickAction("snapshot")` returning screenshot + accessibility tree in one action.
*   **Maturity**: Quick Actions are stable; advanced session/live-view controls are in beta.
*   **Decision**: Prefers one stateless snapshot over separate browser sessions to avoid lifecycle overhead. Live View, recording, and Playwright MCP are out of scope.

### Cloudflare Sandbox SDK (`@cloudflare/sandbox` @ `0.12.3`)
*   **Surface**: `getSandbox`, exec, process, and port APIs.
*   **Maturity**: Beta. Acts as the primary container executor.
*   **Decision**: Ephemeral lifecycles. Coordinator manages state; container backups are unused.

### Cloudflare Workflows
*   **Surface**: `WorkflowEntrypoint` with idempotent provisioning steps.
*   **Maturity**: Stable. Used to handle slow provisioning/destruction lifecycles asynchronously.
*   **Constraint**: Container suspension and PR lifecycles are deferred.

### Dynamic Workers & Code Mode (`@cloudflare/codemode` @ `0.4.2`)
*   **Decision**: **Not installed / disabled**. Facade-based code generation introduces policy bypass risks and runtime unpredictability.

---

## 2. GitHub & Security Architecture

### GitHub App Integration (REST/GraphQL `2022-11-28`)
*   **Decision**: Access is restricted to content read/write and metadata/PR REST APIs. Credentials reside in the Edge proxy. Raw git push is blocked; mutations write directly via GitHub APIs with remote SHA read-back.

### OAuth / MCP Authentication (RFC 9728)
*   **Decision**: Gateway acts as resource server; OAuth flow uses PKCE S256 with JWT Access (1h) and Refresh (30d) tokens. Dev bypass is restricted to non-production environments.

---

## 3. Rejected Alternatives & Reference Designs

### MCP Apps (`@modelcontextprotocol/ext-apps`)
*   **Verdict**: **Not Adopted / Removed**. Frame-injected UI (`ui://`) was trialled and discarded. It rendered inconsistently across chat clients and added duplicate chrome. All UI is handled via plain-text MCP results and the `/approvals/:id` web form.

### Cloudflare VibeSDK / Hosted MCP Servers
*   **Verdict**: VibeSDK (orchestrator with Workers for Platforms) is too broad for the narrow Forge target. Generic container/browser MCP servers lack the required tenant gating and Parallax verification integration.

### Cloudflare Artifacts (Closed Beta)
*   **Verdict**: Excluded from active paths. If adopted, it must reside behind an adapter to prevent isomorphic-git version drift.
