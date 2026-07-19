# Connecting ChatGPT and Claude

Forge is exposed as **one remote MCP server**, consumed by two clients:

- **ChatGPT App** (OpenAI Apps SDK) — Forge appears as an app with an
  interactive widget rendered in the ChatGPT tool-result surface.
- **Claude connector** (remote MCP server) — the same endpoint is added as a
  custom/remote connector in Claude.

Both talk to the same Worker, `@forge/edge-gateway` (`apps/forge-edge-gateway`),
and the same tool + widget surface. There is no second backend.

| Piece | Where |
| --- | --- |
| MCP endpoint | `POST /mcp`, served by the `ForgeMcpSession` Durable Object (`apps/forge-edge-gateway/src/mcp-session.ts`) |
| Tool definitions | `packages/mcp-core/src/index.ts` |
| Tool registration/adapter | `packages/mcp-adapter-v1/src/index.ts` |
| Widget resource | `ui://forge/workspace-console`, `apps/forge-edge-gateway/src/forge-console.ts`, MIME `text/html+skybridge` |
| OAuth | `apps/forge-edge-gateway/src/oauth.ts` |

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

## Interactive widget

`registerForgeConsole()` registers `ui://forge/workspace-console`. Every tool
links to it through adapter `_meta`:

- `_meta.ui = { resourceUri: 'ui://forge/workspace-console', visibility: ['model','app'] }`
- `_meta['openai/outputTemplate'] = 'ui://forge/workspace-console'` (ChatGPT)
- `_meta['openai/toolInvocation/{invoking,invoked}']` status strings

The widget is a single self-contained HTML document (all CSS/JS inline, no
network calls). It shape-detects the last tool's structured output and
renders repositories, Parallax evidence, Git diff/status, or workspace state,
and posts `ui/message` follow-up prompts back to the host. It is read-only —
it never issues its own tool calls independent of what the model already
returned.

## Allowed-link origins

Claude shows a per-link confirmation for `ui/open-link` unless the connector
declares the origins it owns. `oauth.ts` exports `forgeOwnedOrigins(env)`
(`FORGE_PUBLIC_ORIGIN`, `FORGE_PREVIEW_HOSTNAME`) as the source of truth for
this, but as of the `@modelcontextprotocol/ext-apps` version vendored in this
repo there is no spec/SDK field to actually emit it on — the MCP Apps resource
`_meta.ui` schema only accepts `csp`, `permissions`, `domain`, and
`prefersBorder`, and `ui/open-link` carries only `{ url }`. So today, Claude
will prompt on every opened link, including Forge's own approval/preview
pages; `github.com` PR links are not Forge-owned and are expected to keep
prompting regardless.

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
