# Persistence Architecture

Follows control-plane/executor split.

| Component | Stored Data & Durability |
| :--- | :--- |
| **GitHub** | Durable repo files, commits, branches, diffs, history, PRs |
| **D1** | Tenant-visible task/workspace metadata, repo bindings, revisions, idempotency receipts, process/approval indexes |
| **Workspace Coordinator** | Hot session/process/preview state |
| **R2** | Bounded logs, screenshots, evidence |
| **Executor Filesystem** | Ephemeral (never durable) |

## Ephemerality & Lifecycle
- **Creation:** Persists lightweight control-plane session + desired executor profile.
- **Allocation:** Lazy-allocated on first execution tool call; may sleep, be reaped, or be recreated from selected GitHub commit.
- **Transient State:** Discarded command-created files, capabilities, injected secrets, sockets, browser auth.
