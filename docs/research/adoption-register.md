# Adoption register

**Checked:** 20 August 2026  
**Rule:** package files and deployed bindings are authoritative; this register
explains why each dependency exists.

## Active dependencies and integrations

| Dependency | Current pin or surface | Purpose | Main risk or fallback |
|---|---|---|---|
| Cloudflare Agents | `agents` `0.17.3` | `McpAgent` transport and one Durable Object per connected client | Evolving API; isolated in `worker/src/mcp.ts` |
| MCP TypeScript SDK | `@modelcontextprotocol/sdk` `1.29.0` | Five tool schemas and MCP server | Published client catalogues may cache metadata; tool changes are releases |
| Zod | `4.4.3` | Strict tool input and output schemas | Schema size is paid in every model turn |
| Cloudflare Browser Rendering | REST `/snapshot`; Workers types `5.20260712.1` | Public-page screenshots and accessibility tree | 45-second Forge budget; partial viewports must be reported honestly |
| Cloudflare D1 | platform binding | Identity, OAuth, approvals and daily capture meter | Tenancy and deletion procedures are load-bearing |
| Cloudflare R2 | platform binding | Signed hosted copies of capture evidence | Lifecycle configuration must enforce intended expiry |
| GitHub App | REST API `2022-11-28` | Repository-scoped reads, commits, draft PRs, merge and discard | GitHub is deliberately the single durable plane |
| GitHub OAuth | OAuth App flow attached to the GitHub App | Human identity and the narrowly scoped credential needed to create personal repositories | Stored user credential increases review and deletion obligations |
| OAuth 2.1 + PKCE | RFC 9728 resource metadata; S256 | Remote MCP client authorization | Redirect allowlist and signing-key rotation are security boundaries |
| Jose | `6.2.2` | Supporting cryptographic utilities where used | Prefer Web Crypto for the worker's fixed token formats |
| Wrangler | `4.110.0` | Development and deployment | Configuration changes can alter routes and bindings immediately |
| TypeScript / Vitest | `5.9.3` / `4.1.9` | Static checks and invariants | Production GitHub/OAuth behavior still needs recorded live runs |
| PostHog | optional HTTP ingestion | Shape-only activation and reliability analytics | Must never receive repository names, URLs, intents, patches or contents |

## Removed or rejected

| System | Status | Reason |
|---|---|---|
| Cloudflare Sandbox SDK and executor containers | removed | Compute held repository state GitHub did not; failures generated recovery tools and hidden divergence |
| Cloudflare Workflows | removed | No long-running provisioning or execution lifecycle remains |
| Workers AI | removed | Forge plans nothing internally and runs no model |
| R2 logs and general artifact store | removed | Only rendered capture pages remain |
| MCP Apps widget / `@modelcontextprotocol/ext-apps` | rejected | Inconsistent client rendering and duplicate UI; approvals use ordinary signed web pages |
| Cloudflare Code Mode | not adopted | A dynamic facade would broaden policy and selection risk without serving the five-tool product |
| Executor-era progress-potential gate | historical only | There is no command loop or workspace state left to police |

Reconsider a removed system only when a measured user need cannot be expressed
through GitHub durability, one-shot capture or a human approval link.
