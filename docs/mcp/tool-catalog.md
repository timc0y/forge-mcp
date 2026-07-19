# Tool catalog

The first vertical slice exposes thirteen tools:

- `forge_workspace_create`, `forge_workspace_get`, `forge_workspace_destroy`
- `forge_files_tree`, `forge_files_read` (single or multi-file), `forge_files_write`, `forge_files_patch`
- `forge_shell_exec`
- `forge_process_start`, `forge_process_logs`
- `forge_git_status`, `forge_git_diff`
- `forge_preview_expose`
- `forge_browser_screenshot`, `forge_browser_accessibility_tree`, `forge_browser_act`
- `forge_review`, `forge_review_capture`, `forge_artifact_get`

`forge_browser_act` drives bounded interactive journeys against a preview
(navigate, click, fill, press, wait for a selector or text, reload) and then
returns a screenshot and accessibility tree of the resulting state, so
multi-step flows can be proven rather than only single rendered states.

Machine-readable schemas are generated into `schemas/forge-tools.schema.json`. Later phases add snapshot/resume, process stop, full Git/PR, browser accessibility/inspection, context and approvals without changing the existing names.
