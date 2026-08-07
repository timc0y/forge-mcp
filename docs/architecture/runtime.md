# Runtime Architecture

- **Boundary:** `SandboxProvider` is an ephemeral execution boundary. Core/app packages never import Cloudflare types. GitHub (not Sandbox storage) is the durable repository authority.
- **Implementation:** `@cloudflare/sandbox` via `packages/sandbox-cloudflare`.
- **Lazy Allocation:** No sandbox until first shell/install/build/test/dev/preview/deploy call. Allocates an executor with sessions: `system`, `agent-*`, `dev-server`, `test-runner`. Sessions share one ephemeral filesystem and are **not** security boundaries.

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

- **Provider IDs:** Derived from Forge IDs; never accepted from clients.
- **Transport:** RPC, lowercase identifiers, bounded timeouts, stable Forge errors.
- **Path Rules:** Public paths must be repo-relative or absolute at/below `/workspace/repo`. Rejected pre-flight: `/workspace/forge`, `/workspace/tmp`, sibling-prefix, traversal (`..`), NUL bytes. Executor repeats the boundary check.
- **Runtime Verification:** Verified inside the executor at first allocation. Node profile must report exact Node major + Corepack; mismatch fails execution. Workspace creation does not wait for runtime readiness.
- **Executor Cache:** Package-manager caches use `/workspace/cache` (`npm`, pnpm, Yarn, and pip). The cache is reusable while the ephemeral executor survives, but it is never treated as durable repository state and is discarded on reaping.
- **Ephemerality:** Command-created files exist on the executor only. Reap/destroy discards them; recovery re-materializes from GitHub. Wanted changes must go through `forge_edit`.
- **Preview launch contract:** Branch previews infer a root `package.json` `dev` script and framework port, or use a repository-root `forge.json`/`forge.config.json` with a repository-relative `preview.cwd`, exact `preview.command`, and `preview.port`. No environment or secret values are read from this config.
- **Browser Bridge:** Browser Run receives Forge origin + workspace-scoped internal headers. Worker validates headers, resolves preview via coordinator, proxies via `containerFetch`. Responses buffered to **20 MB**. Root-relative assets carry scoped headers; no raw provider URL exists.
