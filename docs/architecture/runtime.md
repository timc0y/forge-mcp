# Runtime architecture

`SandboxProvider` is an ephemeral execution boundary. Core and application
packages do not import Cloudflare types. GitHub, not Sandbox storage, is the
durable repository boundary.

The Cloudflare implementation uses `@cloudflare/sandbox` through
`packages/sandbox-cloudflare`. A control-plane workspace has no sandbox until
the first shell, install, build, test, dev, preview, or deploy operation. That
operation allocates an executor with explicit sessions such as `system`,
`agent-*`, `dev-server`, and `test-runner`. Sessions share one ephemeral
filesystem and are not security boundaries.

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

Provider IDs are derived from Forge IDs and never accepted directly from
clients. The adapter consistently uses RPC transport, lowercase identifiers,
bounded timeouts and stable Forge errors. Public repository paths are either
repo-relative or absolute at/below `/workspace/repo`; `/workspace/forge`,
`/workspace/tmp`, sibling-prefix paths, traversal, and NUL bytes are rejected
by the shared path helper before GitHub access or executor materialization. The
executor repeats the repository-bound check.

Forge verifies the requested runtime from inside the executor when it is first
allocated. A requested Node profile must report that exact Node major plus
Corepack; a mismatch fails the execution request. Workspace creation itself
does not wait for or claim runtime readiness.

Command-created files remain in this executor only. Destroying or reaping the
executor discards them; recovery materializes the GitHub branch afresh, and
wanted repository changes must go through `forge_edit`.

Browser evidence reaches the running service through a private Worker bridge. Browser Run receives the Forge origin plus workspace-scoped internal headers; the Worker validates those headers, resolves the preview in the coordinator and uses `containerFetch` to reach the service. Responses are buffered to a 20 MB bound so browser navigation completes deterministically. Root-relative assets carry the same scoped headers, and no raw provider URL exists to leak or revoke.
