# Cloudflare Agents research

- Repository: `cloudflare/agents`
- Package/version: `agents` 0.17.3
- Maturity: production-capable library with rapidly evolving optional features
- Used surface: `McpAgent` and Streamable HTTP serving
- Selected for Durable Object-backed MCP session transport
- Fallback: direct official MCP SDK Streamable HTTP handler
- Risk: framework lifecycle changes; therefore isolated in the edge session adapter
- Verified: 2026-07-12
- Limitation: it is not the workspace state coordinator
