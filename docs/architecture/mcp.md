# MCP Architecture

- **SDK/Core:** Uses MCP TS SDK v1 (`mcp-adapter-v1`). Single definition source in `mcp-core`; adapters translate schemas/results.
- **State:** Cloudflare `McpAgent` handles protocol session state only. Separate Durable Object manages workspace state (supports 1:N session-to-workspaces, N:1 sessions-to-workspace).
- **Transport:** Streamable HTTP (primary). Stdio proxy (future) forwards to same authenticated endpoint with no business logic.
- **Results & Errors:** Outputs bounded structured JSON; tool metadata defines side effects; provider failures map to stable Forge error codes.
- **Executors & Mutations:**
  - GitHub-only tools allocate no executor; remote mutations use idempotency, content/head/ref preconditions, fresh read-back.
  - Execution tools report process state separately (`remote_persisted: false`).
  - File mutations: Only `forge_edit` returns a durable repository-file mutation receipt.
