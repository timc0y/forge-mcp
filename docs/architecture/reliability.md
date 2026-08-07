# Workspace Reliability Contract

## System Planes

| Plane | Authority & Scope | Ephemeral / Durable |
|---|---|---|
| **GitHub Control Plane** | Sole durable authority for file CRUD, diffs, commits, branches, history, PRs. | Durable |
| **Executor Plane** | Ephemeral compute for shell, installs, builds, tests, dev servers, previews, deploys. | Ephemeral (never a durability boundary) |

## Repository Operations

| Category | Tools | Execution Plane | Guards & Durability Guarantees |
|---|---|---|---|
| **Mutation** | `forge_edit` | GitHub API | Sole public write tool. Reads branch, applies changes, creates Git objects, updates guarded `forge/*` ref, verifies remote SHA matches commit before reporting success. Idempotency keys on retries. Content/revision/head-SHA/ref-SHA guards. Adopts branch collision only if ref matches base SHA. Refuses deleting live-workspace refs; re-reads target SHA pre-deletion. |
| **Push Protection** | `forge_shell` | Executor | Refuses raw `git push`. Local filesystem changes never implicitly promote to GitHub. |
| **Reads & Diffs** | `forge_files_list`, `forge_files_read`, `forge_context_get`, `forge_diff_metadata`, `forge_history`, `forge_branches`, `forge_pr` | GitHub API | Direct GitHub reads; zero executor allocation. Never substitutes executor checkout for repository truth. |

### Path Validation
- **Allowed:** Repo-relative or absolute at/below `/workspace/repo`.
- **Rejected Pre-Flight:** Metadata, temporary, sibling-prefix, traversal (`..`), empty, and NUL-containing paths.

## Control-Plane Workspaces & Lazy Execution

| Stage / Event | Target Signal / Tool | Protocol & Operational Behavior |
|---|---|---|
| **Workspace Creation** | `forge_workspace_create` | Returns `workspace_id` + `operation_id`. No executor provisioned. |
| **Lazy-Create Receipt** | Receipt: `requested`<br>`executor_state: not_loaded`<br>`allowedNextActions: [forge_files_read, forge_edit]` | Healthy outcome. Read/edit directly via GitHub. Do not treat as hung provisioner. |
| **Observer Inspection** | `forge_observer_workspace`<br>`forge_observer_workspaces` | Reports `lifecycle: lazy_control_plane`, `expected_empty_processes`, `expected_empty_logs`. Attaches `stop_polling` after 3 identical successful polls. |
| **Executor Allocation** | Execution tools: shell, install, build, test, dev, preview, deploy | Materializes selected GitHub commit on ephemeral executor. |
| **Not-Ready Polling** | Error: `FORGE_WORKSPACE_NOT_READY` | Poll `forge_workspace_get` until `ready`, then retry *same* tool call. Do not create second workspace. |
| **Bounded Wait** | `forge_process_wait` (`timedOut: true`) | Observes process in max 30s chunks. `timedOut: true` indicates process is still running—never stops/restarts process. Repeat wait with same `process_id`. |
| **Execution Output** | Process result: `remote_persisted: false` | Files modified/created on executor remain ephemeral (no auto-commit). Recreate wanted changes explicitly via `forge_edit`. |
| **Destruction** | Workspace teardown | Terminates control-plane session, discards executor state/files. GitHub branches and `forge_edit` commits persist. |

## Capability Truth & Security

- **`forge_capabilities`:** Reports active tool and approval surface.
- **Observer Tools:** Read-only inspection of control-plane and executor states without side-effects.
- **Secrets:** Injected strictly into authorized executor processes; never persisted to GitHub.
