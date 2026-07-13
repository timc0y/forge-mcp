# ADR 0001: Cloudflare-first provider abstraction

**Status:** accepted

Forge starts on Cloudflare but core packages depend only on provider contracts. Cloudflare implementations live in adapter packages. This isolates beta APIs, keeps MCP schemas stable and preserves an exit path to local Docker, E2B, Daytona or Kubernetes without building those backends now.
