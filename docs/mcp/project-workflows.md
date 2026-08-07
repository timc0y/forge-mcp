# Project workflows (ChatGPT-first)

Use Forge from an ordinary ChatGPT or Claude conversation against repositories
the Forge GitHub App can already see. These recipes assume the model is not
especially careful — Forge instructions and prompts steer the loop.

Connect once: [connectors](../connectors.md). MCP URL: `https://forge.timcoy.uk/mcp`
(or your `FORGE_PUBLIC_ORIGIN/mcp`).

## Before any code

1. Authorize the repositories on the Forge dashboard (`/app`).
2. In ChatGPT/Claude, connect the MCP server and complete GitHub OAuth.
3. Prefer a **Forge prompt** when the host lists them (`plan-work`, `iterate-ui`,
   `fix-bug`, `resume-task`, `start-task`, `review-live-url`, `prepare-draft-pr`).
   Otherwise paste one of the dashboard “Good first prompts”.

## Plan

Ask: *Plan the next change on owner/repo … Do not write code yet.*

Expected tools: `forge_task_create` → `forge_context_get` / `forge_files_read`.
No executor. The durable plan lives on the task (`forge_task_get mode:summary`
survives context compression). Only write `docs/plans/*.md` with `forge_edit`
if you asked for an in-repo plan.

## Iterate UI / design

Ask: *On owner/repo, improve … Iterate with screenshots until phone and desktop
look right.*

Expected loop: `forge_task_create` → `forge_workspace_create` →
`forge_files_read` → one coherent `forge_edit` → `forge_preview` (or
`forge_review` for a live URL) → inspect every image → next edit →
`forge_diff_metadata` → `forge_merge` when you approve.

## Fix a bug

Ask: *Fix … Verify with the narrowest check or screenshots, then submit.*

Reproduce cheapest-first (`forge_review` URL → reads → `forge_shell`). Change
failing code and its test in one `forge_edit`. Re-run the narrow check before
broadening. Then `forge_merge` and echo the approval link only.

## Resume after a weak / compressed session

Ask: *Resume the Forge task on owner/repo* (or use prompt `resume-task`).

Call `forge_task_get mode:resume` or `forge_observer_workspaces`. Reuse the
existing workspace — do not open a second one for the same repository task.

## Cost ladder (do not skip up)

| Need | Tool |
| --- | --- |
| Live site look | `forge_review` (no container) |
| Plan / read / edit | GitHub tools after `forge_workspace_create` |
| Tests / install / dev server | First `forge_shell` / `forge_deps_install` / `forge_preview` |
| Ship | `forge_secret_accounts` → user picks account → `forge_secret_update` → `forge_deploy` (or `forge_merge` for PRs) |

`forge_workspace_create` returning `requested` / `executor_state: not_loaded` is
healthy. Read and edit immediately; compute starts on the first execution tool.

Observer tools that keep showing `state: requested` with empty processes are
not a hang — that is the same lazy session. Proceed with `forge_files_read` /
`forge_edit`. Only poll `forge_workspace_get` after an execution tool returned
`FORGE_WORKSPACE_NOT_READY` and lifecycle is `executor_starting`.

If the first shell/install/preview says the executor is still starting, poll
`forge_workspace_get` every few seconds until `ready`, then retry **that same**
tool. Do not open a second workspace.

Installs and long commands: each `forge_process_wait` observes for at most 30s.
`timedOut:true` means call wait again with the same `process_id` — never raise
the wait toward 600000 or restart the process.

## Related

- [Agent execution playbook](./agent-execution-playbook.md)
- [Archive Index of Completed Plans](../ARCHIVE_INDEX.md)
- [Tool reference](../tools.md)
