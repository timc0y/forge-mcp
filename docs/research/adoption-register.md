# Adoption Register

**Date**: 2026-07-12

Active and rejected dependencies/integrations. Bumping versions requires following the provider-upgrade runbook.

## Registers

| Dependency | Version / Pin | Maturity | API Surface | Rationale | Fallback / Risk |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Cloudflare Sandbox SDK** | `@cloudflare/sandbox` `0.12.4` | Beta | `getSandbox`, RPC, exec, destroy. | Ephemeral Linux sandboxes. | E2B. High risk; containers pull from GitHub. |
| **Cloudflare Agents** | `agents` `0.17.3` | Adopted | `McpAgent`, HTTP streaming sessions. | Durable client state. | Official MCP SDK. Med risk. |
| **MCP TS SDK v1** | `@modelcontextprotocol/sdk` `1.29.0` | Production | `McpServer`, v1 schemas. | Production tool schemas. | Stay on v1. Med risk. |
| **MCP TS SDK v2** | None | Beta | Contract seam only. | Prepare migration. | v1 adapter. High risk. |
| **Cloudflare Browser Run** | Workers Types `5.20260712.1` | Beta | `quickAction("snapshot")`, viewport screenshot. | Evidence capture. | Playwright. Med risk. |
| **Cloudflare Workflows** | Wrangler `4.110.0` | Production | `WorkflowEntrypoint`, retries. | Provision/destruction. | Queues. Med risk. |
| **Cloudflare D1** | Platform | Production | Bindings. | Global metadata store. | Postgres. Med risk. |
| **Cloudflare R2** | Platform | Production | Bindings. | Screenshot/log storage. | S3-compatible. Low risk. |
| **GitHub App** | REST/GraphQL `2022-11-28` | Required | Webhooks, REST file/commit/PR CRUD. | Scoped repo mutations. | Public clone only. High risk. |
| **OAuth** | Protocol RFC 9728 | Production | PKCE S256, JWT Access/Refresh tokens. | Remote MCP auth. | Bearer tokens. High risk. |
| **Cloudflare Code Mode** | `@cloudflare/codemode` `0.4.2` | Experimental | None | Future code efficiency. | MCP tools. High risk. |
| **MCP Apps** | `@modelcontextprotocol/ext-apps` | **Rejected** | None | Trialled widget. | Approvals UI. Closed. |
| **Alchemy** | None | Experimental | None | Environment composition. | Wrangler. High risk. |
