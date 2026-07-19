# Tool catalog

The first vertical slice exposes thirteen tools:

- `forge_workspace_create`, `forge_workspace_get`, `forge_workspace_destroy`
- `forge_files_tree`, `forge_files_read` (single or multi-file), `forge_files_write`, `forge_files_patch`
- `forge_shell_exec`
- `forge_process_start`, `forge_process_logs`
- `forge_git_status`, `forge_git_diff`
- `forge_preview_expose`
- `forge_review`, `forge_review_capture`, `forge_artifact_get`

Browser evidence is just two tools: `forge_review` (an external URL, no
container) and `forge_review_capture` (a running Forge preview). A capture may
carry optional `steps` (navigate, click, fill, press, wait for a selector or
text, reload) to drive a real interaction before the shot, so multi-step flows
can be proven rather than only single rendered states — there is no separate
screenshot / accessibility / act tool.

## Durable task tools

A task is a durable coding-session record that lives above the disposable
workspace. It survives MCP reconnects, ChatGPT context compression, container
sleep and client reconnection. None of these tools create a container.

- `forge_task_start` — create a durable task (goal, base ref, decisions,
  non-goals, likely paths). Call this first for any coherent piece of work.
- `forge_task_get` — return the full durable task record.
- `forge_task_summary` — return a compact reconnect summary (goal, decisions,
  state, files read/changed, checks, evidence, outstanding work and the next
  recommended action) with secrets redacted and no full source, logs or diffs.
- `forge_task_list` — list recent tasks for the account, optionally by state.
- `forge_task_finish` — move a task to a terminal state (complete/failed/
  cancelled); the record and its evidence remain retrievable afterwards.

The task record is persisted in D1 (`tasks` table, migration `0009_tasks.sql`)
and modelled in `@forge/task-core`. Resume-relevant context is stored as bounded
JSON that never holds secrets, full source, complete logs or raw diffs; large
evidence stays in R2 and is referenced by artifact id.

Machine-readable schemas are generated into `schemas/forge-tools.schema.json`. Later phases add snapshot/resume, process stop, full Git/PR, browser accessibility/inspection, context and approvals without changing the existing names.
