# MCP architecture

Production uses the supported MCP TypeScript SDK v1 line through `mcp-adapter-v1`. Tool definitions live once in `mcp-core`; adapters translate schemas and results.

Cloudflare `McpAgent` owns protocol-session state only. Workspace state lives in a separate Durable Object so one session may use many workspaces and several authorized sessions may observe one workspace.

Primary transport is Streamable HTTP. A future stdio proxy forwards to the same authenticated endpoint and contains no business logic.

All tool results include structured JSON. Side effects are described in tool
metadata, outputs are bounded, and provider failures map to stable Forge error
codes. GitHub-only tools allocate no executor. Execution tools expose process
state separately and report `remote_persisted:false`; only `forge_edit` returns
a durable repository-file mutation receipt. Remote GitHub mutations use
idempotency, content/head/ref preconditions, and fresh provider read-back.
