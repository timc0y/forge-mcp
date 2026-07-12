# Forge MCP 0.5 platform options

Verified 12 July 2026 against first-party documentation and repositories.

## Cloudflare MCP and Agents

Cloudflare's Agents SDK supports remote MCP servers, Streamable HTTP, OAuth integration, stateful `McpAgent` deployments and stateless MCP handlers. Use a stateless handler when tools do not need session state; use a Durable Object-backed agent only when resumability or per-session state is required.

- [Build a Remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [McpAgent API](https://developers.cloudflare.com/agents/model-context-protocol/apis/agent-api/)
- [Cloudflare Agents repository](https://github.com/cloudflare/agents)
- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/)

## Repository execution

Cloudflare Sandbox is built on Containers and provides Linux files, commands, processes, package managers, previews and isolated execution. It is the correct runtime boundary for arbitrary repository builds and tests. The Sandbox transport should use RPC; the older HTTP and WebSocket transports are being deprecated.

- [Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [Sandbox architecture](https://developers.cloudflare.com/sandbox/concepts/architecture/)
- [Sandbox transport modes](https://developers.cloudflare.com/sandbox/configuration/transport/)
- [Sandbox SDK repository](https://github.com/cloudflare/sandbox-sdk)

## Browser evidence

Browser Run can be called directly from a Worker through a binding without an external API token. It supports screenshots and broader browser sessions. It is suitable for Parallax evidence when Forge has an approved preview URL or when a Sandbox exposes a running service.

- [Browser Run quick actions](https://developers.cloudflare.com/browser-run/get-started/)
- [Browser Run screenshot endpoint](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/)
- [Browser Run changelog](https://developers.cloudflare.com/changelog/product/browser-run/)

## State, artifacts and internal integration

Durable Objects provide strongly consistent workspace coordination. R2 is appropriate for screenshots, logs and reports. Service Bindings provide an internal Worker-to-Worker RPC path without routing through a public URL, which is the preferred native integration boundary for Parallax.

Cloudflare Artifacts provides versioned Git-compatible repositories and worker-side Git operations, but it is currently closed beta. It should remain behind an adapter until its availability and API stability fit Forge's production requirements.

- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
- [Artifacts with isomorphic-git](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/)
- [Artifacts with Sandbox](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

## Dynamic Workers, Code Mode and Workers for Platforms

Dynamic Workers are a lightweight isolated JavaScript/Python runtime and are useful for Code Mode tool orchestration. They do not replace a Linux repository workspace. Workers for Platforms is designed for platforms that deploy many user Workers and has a separate paid plan, so it should not be a Forge 0.5 prerequisite.

- [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
- [Code Mode example](https://developers.cloudflare.com/dynamic-workers/examples/codemode/)
- [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
- [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)

## Reference implementations

Cloudflare VibeSDK demonstrates a larger AI coding platform using phased generation, Container previews, GitHub OAuth and Workers for Platforms deployment. It is a useful reference for product flow and onboarding, but too broad to adopt as Forge's base.

Cloudflare's hosted MCP server repository includes Browser and Container MCP servers. These are useful for comparison and prototypes, but Forge should retain its own policy, GitHub App, Parallax evidence and tenant boundary rather than depending on a generic hosted server.

- [Cloudflare VibeSDK](https://github.com/cloudflare/vibesdk)
- [Cloudflare MCP servers](https://github.com/cloudflare/mcp-server-cloudflare)

## Deployment conclusion

Forge 0.5 should expose one stable contract with two providers:

- self-hosted Cloudflare deployment, where the user owns the account and usage costs;
- Forge Cloud, where Forge owns the account and bills for an allowance plus measured usage.

Both modes should use the same MCP schemas, Parallax adapter, security policy and evidence format. The hosted mode adds tenancy, quotas, billing and operational controls; it should follow a successful self-hosted review flow rather than precede it.
