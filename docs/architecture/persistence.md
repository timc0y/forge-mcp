# Persistence architecture

Persistence follows the control-plane/executor split.

- **GitHub** stores all durable repository files, commits, branches, diffs,
  history, and pull requests.
- **D1** stores tenant-visible task/workspace metadata, repository bindings,
  revisions, idempotency receipts, and process/approval indexes.
- **Workspace Coordinator state** stores hot session/process/preview state.
- **R2** stores bounded logs, screenshots, and evidence.
- **Executor filesystems** are ephemeral and never repository persistence.

Creating a workspace persists only a lightweight control-plane session and its
desired executor profile. An executor is allocated on the first execution tool
and may sleep, be reaped, or be recreated by materializing the selected GitHub
commit. Command-created files are intentionally discarded when that executor
ends; capabilities, injected secrets, sockets, and browser authentication are
never durable state.
