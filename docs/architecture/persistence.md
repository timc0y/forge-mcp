# Persistence architecture

Persistence follows the control-plane/executor split.

- **GitHub** stores all durable repository files, commits, branches, diffs,
  history, and pull requests.
- **D1** stores tenant-visible task/workspace metadata, repository bindings,
  revisions, idempotency receipts, and process/approval indexes.
- **Workspace Coordinator state** stores hot session/process/preview state.
- **R2** stores bounded logs, screenshots, evidence, and explicit executor
  snapshots.
- **Executor filesystems** are ephemeral and never repository persistence.

Creating a workspace persists only a lightweight control-plane session and its
desired executor profile. An executor is allocated on the first execution tool
and may sleep, be reaped, or be recreated from the selected GitHub commit.

Executor snapshots support local rollback during one coding session. They may
include ignored/build state, but they never change GitHub and must not be used
as evidence that command-created files are remotely durable. Capabilities,
injected secrets, sockets, and browser authentication are excluded.
