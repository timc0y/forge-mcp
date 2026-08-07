# Client Connectors & OAuth Setup

Forge exposes one streamable MCP API for ordinary ChatGPT and Claude
conversations. `/mcp` is the only public tool endpoint and advertises the ten
direct-chat tools.

## Endpoint & Routing Map

| Component | Purpose / Location |
| :--- | :--- |
| **MCP API** | `POST /mcp` -> `ForgeMcpSession` Durable Object (`apps/forge-edge-gateway/src/mcp-session.ts`) |
| **Tool Definitions** | `packages/mcp-core/src/index.ts` |
| **Tool Registration** | `packages/mcp-adapter-v1/src/index.ts` |
| **OAuth Routes** | `apps/forge-edge-gateway/src/oauth.ts` |
| **Approval Flow** | `GET/POST /approvals/:id` served by `github.ts` |

## OAuth Flow Lifecycle

1. **Discovery**: `GET /.well-known/oauth-authorization-server` advertises endpoints, S256 PKCE challenge support, and authorization/refresh code grants. `GET /.well-known/oauth-protected-resource` or `/mcp` metadata returns the sole resource target, `${FORGE_PUBLIC_ORIGIN}/mcp`.
2. **Registration (DCR)**: `POST /oauth/register` registers public clients (`token_endpoint_auth_method: none`). Redirect URIs must match `FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS` (defaults to OpenAI/Anthropic/localhost domains).
3. **Authorize**: `GET/POST /oauth/authorize` checks code challenge and issues a 10-minute authorization code stored in D1.
4. **Token**: `POST /oauth/token` validates PKCE or rotates refresh token to issue Access (JWT, HS256, 1h TTL) and Refresh (30d TTL) tokens with scope `forge:workspace offline_access`.

Bearer tokens are validated per request in `src/auth.ts` and set session identity context (`tenantId`, `projectId`).

## UI & Approvals
*   **No In-Chat Widgets**: Results return as plain text or structured JSON. Statuses are reported via short text in `_meta['openai/toolInvocation/{invoking,invoked}']`.
*   **Approval Page**: Gated mutations (e.g. branch push/merge) return an `approval_url` in the tool output pointing to `approvals/:id`. Clients with `elicitation.url` support render this inline.

## Environment Variables
*   `FORGE_PUBLIC_ORIGIN`: Canonical gateway origin.
*   `FORGE_PREVIEW_HOSTNAME`: Hostname for exposed worker previews.
*   `FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS`: Domain allow-list for DCR.
*   `FORGE_CAPABILITY_SIGNING_KEY`: HS256 key for access/refresh tokens.
*   `FORGE_SESSION_SIGNING_KEY`: Optional OAuth token signer override.
