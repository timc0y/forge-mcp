# Tool catalog

Forge exposes a small MCP tool set (~33 tools). Machine-readable schemas are generated into `schemas/forge-tools.schema.json`.

## Discover

- `forge_capabilities` — session capability manifest
- `forge_repository_list` — authorized GitHub repos (no container)

## Tasks (durable, container-free)

- `forge_task_create` — create a durable task
- `forge_task_get` — `mode`: `full` | `summary` | `resume`
- `forge_task_list` — recent tasks
- `forge_task_update` — finish (`outcome`) and/or record `handoff_summary` + `next_steps`

## Workspace

- `forge_workspace_create` — waits until ready by default (do not poll-loop)
- `forge_workspace_get` — compact status + `allowedNextActions`
- `forge_workspace_destroy`
- `forge_doctor` — reconcile Git / processes / deps after reconnect
- `forge_operation_get` — resolve uncertain prior mutation by `op_...`

## Files

- `forge_files_list`, `forge_files_read`, `forge_files_write`

## Shell and processes

- `forge_shell` — run a command; `mode:read_only` for probes; `async:true` for long work (`proc_` id → `forge_process_wait`)
- `forge_process_list` — all processes, or one when `process_id` is set
- `forge_process_wait` — observational timeouts (`timedOut` + `suggestedTimeoutMs`; do not restart)
- `forge_process_logs` — incremental logs via cursor
- `forge_process_stop` — `force:true` for hard cancel
- `forge_deps_install` — managed install; may return `processId` for wait

## Git and ship

- `forge_git_status`
- `forge_git_diff` — `scope`: `worktree` | `staged` | `outgoing`
- `forge_git_branch`, `forge_git_commit`
- `forge_submit` — one-call stage + queue draft PR (human approves later)

## Review

- `forge_review` — screenshot any public URL (no container)
- `forge_preview_expose` — expose a process URL (private by default)
- `forge_preview` — screenshot workspace app (auto-starts/exposes when needed; optional interaction `steps`)
- `forge_artifact_get` — fetch stored artifact / image

## Secrets

- `forge_secret_list`, `forge_secret_create`, `forge_secret_update`, `forge_secret_delete`
- `forge_secret_attach` — attach (approval) or `attached:false` to detach

Secrets can also be created in the portal UI at `/app/secrets`.

## Removed / folded (clean break)

Not advertised: credential profiles, Cloudflare deploy helper, check_*, process_start/get/cancel,
operation_reconcile, files_patch, context_*, diff_metadata, git_push / pull_request_create /
push envelopes, workspace prove/checkpoint/restore/export, task_summary/resume/handoff/finish
(as separate tools). Use the folded tools above instead.
