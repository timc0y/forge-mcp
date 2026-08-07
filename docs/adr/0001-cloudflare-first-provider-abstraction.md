# ADR 0001: Cloudflare-first provider abstraction

- **Status:** accepted
- **Design:** Forge starts on Cloudflare; core depends on provider contracts. Cloudflare implementations in adapter packages.
- **Rationale:** Isolates beta APIs, stabilizes MCP schemas, preserves exit paths (local Docker, E2B, Daytona, Kubernetes).
