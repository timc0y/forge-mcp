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

Machine-readable schemas are generated into `schemas/forge-tools.schema.json`. Later phases add snapshot/resume, process stop, full Git/PR, browser accessibility/inspection, context and approvals without changing the existing names.
