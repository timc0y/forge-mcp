# Runtime architecture

`SandboxProvider` is the durable boundary. Core and application packages do not import Cloudflare types.

The Cloudflare implementation uses `@cloudflare/sandbox` 0.12.3 through `packages/sandbox-cloudflare`. Every Forge workspace maps to one provider sandbox and uses explicit sessions: `system`, `agent-*`, `dev-server`, `test-runner`, and `indexer`. Sessions share a filesystem and are not security boundaries.

```text
/workspace/
  repo/
  cache/
  artifacts/
  tmp/
  forge/
    manifest.json
    repository.json
    environment.json
    processes.json
```

Provider IDs are derived from Forge IDs and never accepted directly from clients. The adapter consistently uses RPC transport, lowercase identifiers, bounded timeouts and stable Forge errors. Repository paths are checked in Forge and again inside the runtime.

Forge verifies the requested runtime from inside the provisioned sandbox before a workspace is marked ready. A requested Node profile must report that exact Node major plus Corepack; a mismatch is a provisioning failure, never a misleading ready workspace. The deployed Cloudflare Sandbox image and the default workspace profile use Node 24; the local Docker provider selects `node:22-bookworm-slim` or `node:24-bookworm-slim` from the requested profile.

Browser evidence reaches the running service through a private Worker bridge. Browser Run receives the Forge origin plus workspace-scoped internal headers; the Worker validates those headers, resolves the preview in the coordinator and uses `containerFetch` to reach the service. Responses are buffered to a 20 MB bound so browser navigation completes deterministically. Root-relative assets carry the same scoped headers, and no raw provider URL exists to leak or revoke.
