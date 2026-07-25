# Connecting ChatGPT and Claude

Forge is exposed as **one remote MCP server**, consumed by two clients:

- **ChatGPT App** (OpenAI Apps SDK) — Forge appears as an app with an
  interactive widget rendered in the ChatGPT tool-result surface.
- **Claude connector** (remote MCP server) — the same endpoint is added as a
  custom/remote connector in Claude.

Both talk to the same Worker, `@forge/edge-gateway` (`apps/forge-edge-gateway`),
and the same tool surface. There is no second backend.

| Piece | Where |
| --- | --- |
| MCP endpoint | `POST /mcp`, served by the `ForgeMcpSession` Durable Object (`apps/forge-edge-gateway/src/mcp-session.ts`) |
| Tool definitions | `packages/mcp-core/src/index.ts` |
| Tool registration/adapter | `packages/mcp-adapter-v1/src/index.ts` |
| OAuth | `apps/forge-edge-gateway/src/oauth.ts` |
| Approval page | `approvalPage()` in `apps/forge-edge-gateway/src/github.ts`, served at `GET/POST /approvals/:id` |

## OAuth flow (as implemented)

All handlers live in `oauth.ts` and are routed from `src/index.ts`.

1. **Discovery** — `GET /.well-known/oauth-authorization-server` advertises
   `authorization_endpoint`, `token_endpoint`, `registration_endpoint`,
   `code_challenge_methods_supported: ['S256']`, and
   `grant_types_supported: ['authorization_code','refresh_token']`.
   `GET /.well-known/oauth-protected-resource[/mcp]` advertises the resource
   (`${FORGE_PUBLIC_ORIGIN}/mcp`); a `401` from `/mcp` also returns a
   `WWW-Authenticate` header pointing at it.
2. **Dynamic Client Registration** — `POST /oauth/register`. Redirect URIs
   must be HTTPS (except `localhost`/`127.0.0.1`) and match an allow-list of
   hosts (`FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS`, default
   `chatgpt.com,openai.com,claude.ai,anthropic.com,localhost,127.0.0.1`).
   Clients are stored in D1 (`oauth_clients`) as public clients
   (`token_endpoint_auth_method: none`).
3. **Authorize** — `GET/POST /oauth/authorize`. Requires `response_type=code`,
   a registered `redirect_uri`, and a PKCE `code_challenge` with
   `code_challenge_method=S256`. The user authenticates via the GitHub App web
   session or an owner/dev token. A hashed authorization code is persisted in
   D1 (`oauth_codes`) for 10 minutes.
4. **Token** — `POST /oauth/token`.
   - `grant_type=authorization_code`: single-use code, PKCE verifier checked,
     then an access + refresh JWT (HS256) are issued.
   - `grant_type=refresh_token`: verifies the refresh JWT and rotates a fresh
     access + refresh pair.
   - Access token TTL 1h, refresh TTL 30d. Scopes: `forge:workspace
     offline_access`.

Bearer access tokens are verified per request in `src/auth.ts` and become the
session's `subject`, `tenantId`, `projectId`, and `clientId`.

Session-JWT signing can be split from capability-token signing via the
`FORGE_SESSION_SIGNING_KEY` secret (falls back to
`FORGE_CAPABILITY_SIGNING_KEY` if unset) — see [security.md](security.md).

## No in-chat widget

Forge deliberately serves **no** MCP Apps (`ui://`) resource, and no tool
carries `_meta.ui` or `_meta['openai/outputTemplate']`. Tool results render as
the host's own plain text/structured output.

There was previously a `ui://forge/workspace-console` widget that shape-detected
the last tool's output and drew repository cards, Parallax evidence galleries,
diff viewers and scorecards. It was removed: it rendered unreliably across
hosts, and where it did render it showed a large amount of chrome around
information the model was already stating in chat. The only `_meta` the adapter
still emits is:

- `_meta['openai/toolInvocation/{invoking,invoked}']` — short (≤64 char) status
  strings, plain text, no component.

`tests/unit/mcp.test.ts` asserts no tool advertises a widget, so re-adding one
is a deliberate act rather than an accident.

The one piece of Forge-authored UI a user sees is the **approval page** at
`/approvals/:id` (`approvalPage()` in `github.ts`) — the Approve / Deny form
that gates pushes, pull requests and privileged commands. Tool results surface
it as an `approval_url` in `structuredContent` for the model to relay. Hosts
also show their own native tool-confirmation prompt; that is host UI, not ours.

`inline-approval.ts` can additionally surface that same decision inline via
MCP URL-mode elicitation (`elicitation/create`, mode `url`). It is inert until
a client advertises the `elicitation.url` capability, and every failure path
falls back to the `approval_url` link.

Official docs: <https://claude.com/docs/connectors>,
<https://developers.openai.com/apps-sdk>.

## Setting up a connector

1. Deploy Forge (see [operations.md](operations.md)) so you have a public
   `FORGE_PUBLIC_ORIGIN`.
2. In ChatGPT: add a custom connector pointing at
   `https://<your-origin>/mcp`; ChatGPT performs DCR and the OAuth flow above
   automatically.
3. In Claude (Team/Enterprise org required for custom connectors): Settings →
   Connectors → Add custom connector, same URL.
4. Authorize the GitHub App (`forge-mcp-cloud` in the hosted pilot) against
   the repositories you want Forge to work on.

## Environment variables referenced

- `FORGE_PUBLIC_ORIGIN` — canonical origin (issuer, approval/preview URLs).
- `FORGE_PREVIEW_HOSTNAME` — dedicated preview host.
- `FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS` — DCR redirect-host allow-list.
- `FORGE_OAUTH_AUTHORIZATION_SERVER` / `FORGE_OAUTH_ISSUER` — override advertised AS.
- `FORGE_CAPABILITY_SIGNING_KEY` — HS256 signing key for access/refresh JWTs and capability tokens.
- `FORGE_SESSION_SIGNING_KEY` — optional, splits OAuth session signing from capability signing.
