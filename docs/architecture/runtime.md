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

The first image is based on the pinned Cloudflare Sandbox image. Runtime profiles are policy labels in Phase 1; separate images become real only after image compatibility tests exist.
