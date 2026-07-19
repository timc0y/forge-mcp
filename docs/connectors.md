# Forge connectors (ChatGPT App + Claude connector)

Forge is exposed as **one remote MCP server** that is consumed by two directories:

- **ChatGPT App** (OpenAI Apps SDK) — Forge appears as an app with an interactive
  widget rendered in the ChatGPT tool-result surface.
- **Claude connector** (remote MCP server) — the same endpoint is added as a
  custom/remote connector in Claude.

Both talk to the same worker, `@forge/edge-gateway`
(`apps/forge-edge-gateway`), and the same tool + widget surface. There is no
second backend.

## Surfaces at a glance

| Piece | Where | Notes |
| --- | --- | --- |
| MCP endpoint | `POST /mcp` | `apps/forge-edge-gateway/src/index.ts`; served by `ForgeMcpSession` (`src/mcp-session.ts`). |
| Tools (v1) | `packages/mcp-core/src/index.ts` (definitions) + `packages/mcp-adapter-v1/src/index.ts` (registration) | `forge_repository_list`, `forge_review`, `forge_workspace_*`, `forge_files_*`, `forge_shell_exec`, `forge_git_*`, `forge_pull_request_create`, `forge_preview_expose`, `forge_review_capture`, `forge_artifact_get`. |
| Widget resource | `ui://forge/workspace-console` | `apps/forge-edge-gateway/src/forge-console.ts` (`registerForgeConsole`), MIME `text/html+skybridge`, self-contained HTML/CSS/JS (no external network). |
| OAuth | `apps/forge-edge-gateway/src/oauth.ts` | Authorization Code + PKCE + Dynamic Client Registration + refresh tokens. |

## OAuth flow (as implemented)

All handlers live in `apps/forge-edge-gateway/src/oauth.ts` and are routed from
`src/index.ts`.

1. **Discovery**
   - `GET /.well-known/oauth-authorization-server` → `authorizationServerMetadata(env)`
     (`oauth.ts`). Advertises `authorization_endpoint`, `token_endpoint`,
     `registration_endpoint`, `code_challenge_methods_supported: ['S256']`,
     `grant_types_supported: ['authorization_code','refresh_token']`,
     `token_endpoint_auth_methods_supported: ['none']`.
   - `GET /.well-known/oauth-protected-resource[/mcp]` → emitted inline in
     `src/index.ts` (resource = `${FORGE_PUBLIC_ORIGIN}/mcp`). A `401` from `/mcp`
     also returns a `WWW-Authenticate` header pointing at it
     (`src/auth.ts`).
2. **Dynamic Client Registration** — `POST /oauth/register` → `registerClient()`.
   Redirect URIs are validated against `redirectUriAllowed()`, which enforces
   HTTPS (except `localhost`/`127.0.0.1`) and an allow-list of hosts
   (`FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS`, default
   `chatgpt.com,openai.com,claude.ai,anthropic.com,localhost,127.0.0.1`).
   Clients are stored in D1 (`oauth_clients`); `token_endpoint_auth_method: none`
   (public client).
3. **Authorize** — `GET/POST /oauth/authorize` → `authorize()`. Requires
   `response_type=code`, a registered `redirect_uri`, and a PKCE `code_challenge`
   with `code_challenge_method=S256`. The end user is authenticated either via the
   GitHub App web session (`getWebSession`) or an owner/dev token. A hashed
   authorization code is persisted in D1 (`oauth_codes`) for 10 minutes.
4. **Token** — `POST /oauth/token` → `token()`.
   - `grant_type=authorization_code`: single-use code (marked `used_at`), PKCE
     verifier checked with `verifyPkce()`, then an access + refresh JWT
     (HS256, signed with `FORGE_CAPABILITY_SIGNING_KEY`) are issued.
   - `grant_type=refresh_token`: verifies the refresh JWT and rotates a fresh
     access + refresh pair.
   - Access token TTL 1h, refresh TTL 30d (`ACCESS_TOKEN_SECONDS`,
     `REFRESH_TOKEN_SECONDS`). Scopes: `forge:workspace offline_access`.

Bearer access tokens are verified per request in `src/auth.ts` and become the
session `props` (`subject`, `tenantId`, `projectId`, `clientId`) used by
`ForgeMcpSession`.

## Interactive widget

`registerForgeConsole()` registers the `ui://forge/workspace-console` resource.
Every tool is linked to it through the adapter's tool `_meta`
(`packages/mcp-adapter-v1/src/index.ts`):

- `_meta.ui = { resourceUri: 'ui://forge/workspace-console', visibility: ['model','app'] }`
- `_meta['openai/outputTemplate'] = 'ui://forge/workspace-console'` (ChatGPT)
- `_meta['openai/toolInvocation/{invoking,invoked}']` status strings.

The widget is a single self-contained HTML document (all CSS/JS inline, no
network calls). It shape-detects the last tool's `structuredContent` and renders
repositories, Parallax evidence, git diff/status, or a workspace, and posts
`ui/message` follow-up prompts back to the host.

## Allowed-link URIs (Claude "skip the confirm prompt")

Claude shows a per-link confirmation for `ui/open-link` **unless** the connector
declares the origins it owns. Forge's own origins (so approval and preview links
opened from the widget could skip the prompt) are:

- `FORGE_PUBLIC_ORIGIN` — serves `/approvals/:id` and `/preview/…`.
- `FORGE_PREVIEW_HOSTNAME` — the dedicated preview host (workers.dev preview).

`github.com` PR links are **not** Forge-owned and are expected to keep prompting.

**Status / caveat (important).** As of `@modelcontextprotocol/ext-apps@1.7.2`
(the version vendored in this repo) there is **no allowed-link-URIs field** in
the spec/SDK:

- The MCP Apps resource `_meta.ui` schema (`McpUiResourceMeta`) only accepts
  `csp`, `permissions`, `domain`, and `prefersBorder` — no owned-origins list.
- `ui/open-link` (`McpUiOpenLinkRequest`) carries only `{ url }`; the host, not
  the server, decides whether to confirm.
- The OAuth metadata surfaces (authorization-server / protected-resource
  metadata) have no such field either.

So this **cannot currently be emitted from `oauth.ts`** without inventing a
non-standard field. Instead, `oauth.ts` exports `forgeOwnedOrigins(env)` as a
single source of truth for the owned-origin derivation. When a real host/spec
field appears, it belongs on the **widget resource `_meta.ui`** in
`apps/forge-edge-gateway/src/forge-console.ts` (or wherever server/app metadata
is advertised to Claude) — i.e. the resource owner should consume
`forgeOwnedOrigins(env)` there. Tracked as **TODO** below.

Official docs: <https://claude.com/docs/connectors>,
<https://developers.openai.com/apps-sdk>.

## Directory submission checklist

### ChatGPT Apps directory (Apps SDK)

Docs: <https://developers.openai.com/apps-sdk>

| Item | Status | Detail |
| --- | --- | --- |
| OAuth (Auth Code + PKCE + DCR + refresh) | **DONE** | `oauth.ts` — full flow above. |
| Tool `title` on every tool | **DONE** | `packages/mcp-core/src/index.ts`. |
| Tool annotations (read-only / destructive / idempotent / open-world hints) | **DONE** | `toolAnnotations()` in `packages/mcp-adapter-v1/src/index.ts`. |
| Widget template wired to tools (`openai/outputTemplate`) | **DONE** | adapter `_meta`. |
| Tool invocation status strings | **DONE** | `openai/toolInvocation/*`. |
| `outputSchema` on tools | **TODO** | Adapter forwards `outputSchema` if a definition supplies one, but no `forgeTools` definition currently defines one. Add per-tool output schemas. |
| Dedicated domain (`_meta.ui.domain`) | **TODO** | `forge-console.ts` sets only `_meta.ui.prefersBorder`; no `domain` is declared. |
| CSP declaration (`_meta.ui.csp`) | **TODO / N-A** | Widget is fully inline (no external `connect`/`resource`/`frame` origins), so no CSP is strictly required today; declare an explicit `csp` if any external asset/domain is ever added. |
| Privacy policy URL, listing metadata (name, description, icons, screenshots) | **TODO** | Directory-listing assets, not in-repo. |

### Claude connectors directory

Docs: <https://claude.com/docs/connectors>

| Item | Status | Detail |
| --- | --- | --- |
| Remote MCP server reachable over HTTPS | **DONE** | `POST /mcp`. |
| OAuth (Auth Code + PKCE + DCR + refresh) | **DONE** | `oauth.ts`; `claude.ai`/`anthropic.com` are in the default redirect allow-list. |
| Tool titles | **DONE** | `title` on every tool. |
| Tool hints (annotations) | **DONE** | read-only / destructive / idempotent / open-world hints. |
| Allowed-link URIs (skip open-link confirm) | **TODO** | No spec/SDK field in `ext-apps@1.7.2`; owned origins available via `forgeOwnedOrigins(env)`. Belongs on the widget resource `_meta.ui` (`forge-console.ts`) once a host field exists. See section above. |
| Team/Enterprise org | **TODO (external)** | Custom/remote connectors require a Claude Team or Enterprise organization to add and (for directory listing) an org that meets Anthropic's directory requirements. |
| 3–5 PNG carousel screenshots, ≥1000px, cropped to the app response (prompt excluded) | **TODO** | Marketing assets, not in-repo. |
| Privacy policy URL | **TODO** | Not in-repo. |
| Test account credentials | **TODO** | Provide a Forge test tenant/login for review. |

## Environment variables referenced

- `FORGE_PUBLIC_ORIGIN` — canonical origin (issuer, approval/preview URLs).
- `FORGE_PREVIEW_HOSTNAME` — dedicated preview host.
- `FORGE_OAUTH_ALLOWED_REDIRECT_HOSTS` — DCR redirect-host allow-list.
- `FORGE_OAUTH_AUTHORIZATION_SERVER` / `FORGE_OAUTH_ISSUER` — override advertised AS.
- `FORGE_CAPABILITY_SIGNING_KEY` — HS256 signing key for access/refresh JWTs.
</content>
</invoke>
