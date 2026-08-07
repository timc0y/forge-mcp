# Tool Reference

Forge exposes 45 MCP tools defined in [`packages/mcp-core/src/index.ts`](../packages/mcp-core/src/index.ts). Machine-readable schemas are generated at [`schemas/forge-tools.schema.json`](../schemas/forge-tools.schema.json).

*   **Repository Operations**: Done via GitHub API. No executor allocated.
*   **Execution Operations**: ephemereal sandbox container allocated on demand. File changes are local; `remote_persisted: false`. Commit via `forge_edit`.

## 1. Discovery & Observation (Container-Free)
*   `forge_capabilities`: Get current capabilities (Git, secrets, previews).
*   `forge_observer_workspaces`: List workspace slots and execution states.
*   `forge_observer_workspace`: Get process logs and details.
*   `forge_observer_activity`: Inspect audit logs.
*   `forge_repository_list`: List repositories authorized on the GitHub App.

## 2. Durable Tasks (Container-Free)
*   `forge_task_create`: Start a task with goal, decisions, and non-goals.
*   `forge_task_get`: Retrieve task details or resume summaries.
*   `forge_task_list`: Query task histories.
*   `forge_task_update`: Update goals, set outcomes, or mark complete/failed.

## 3. Workspace & Branch Lifecycle
*   `forge_start`: Create `forge/<slug>` branch from base ref. Idempotent.
*   `forge_workspace_create`: Register lightweight workspace DO metadata.
*   `forge_workspace_get`: Inspect current processes, previews, and dependencies.
*   `forge_workspace_destroy`: Delete sandbox container; revoke previews.
*   `forge_operation_get`: Check async operation status by ID.

## 4. Repository CRUD (Container-Free)
*   `forge_files_list`: List repo files. Path must be at or below `/workspace/repo`.
*   `forge_files_read`: Read file contents.
*   `forge_edit`: Write, delete, or patch files and commit directly to GitHub.
*   `forge_diff_metadata`: Inspect syntax-only changes against base branch.
*   `forge_context_get`: Rank files relevant to task goals and paths.

## 5. Workspace Execution
*   `forge_shell`: Run command in sandbox container (max 30s; spills to background).
*   `forge_process_list`: List or query active processes.
*   `forge_process_wait`: Observe a running process. Timeout does not terminate command.
*   `forge_process_logs`: Fetch incremental stdout/stderr logs.
*   `forge_process_stop`: Cancel running process.
*   `forge_deps_install`: Start dependency installations.

## 6. Git History & PRs (Container-Free)
*   `forge_access`: Verify read/write grants.
*   `forge_history`: Read branch or file commit logs.
*   `forge_branches`: List branch tips or delete branches.
*   `forge_pr`: Query merge status, check run status, merge, or close PR.
*   `forge_merge`: Create PR and generate human approval URL.

## 7. Deploy & Previews
*   `forge_deploy`: Execute deployments using attached secrets.
*   `forge_review`: Capture screenshots/accessibility trees from external URL.
*   `forge_preview_expose`: Expose sandbox process via private URL.
*   `forge_preview`: Spin up and capture screenshots of workspace preview.
*   `forge_artifact_get`: Fetch stored screenshot binaries or base64.
*   `forge_artifact_upload`: Upload base64 objects to workspace storage.

## 8. Secrets Management
*   `forge_secret_list`: Query stored variable labels (excludes values).
*   `forge_secret_accounts`: List accounts using active tokens.
*   `forge_secret_create`: Write encrypted variables.
*   `forge_secret_update`: Patch or delete individual keys.
*   `forge_secret_delete`: Erase credentials.
*   `forge_secret_attach`: Map secrets to workspace environment.
