# Tool catalog

The first vertical slice exposes thirteen tools:

- `forge_workspace_create`, `forge_workspace_get`, `forge_workspace_destroy`
- `forge_files_tree`, `forge_files_read`, `forge_files_patch`
- `forge_shell_exec`
- `forge_process_start`, `forge_process_logs`
- `forge_git_status`, `forge_git_diff`
- `forge_preview_expose`
- `forge_browser_screenshot`

Machine-readable schemas are generated into `schemas/forge-tools.schema.json`. Later phases add snapshot/resume, process stop, full Git/PR, browser accessibility/inspection, context and approvals without changing the existing names.
