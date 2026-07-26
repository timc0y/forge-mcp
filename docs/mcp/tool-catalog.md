# Tool catalog

Forge exposes workspace, repository, file, shell, process, Git, preview, browser evidence, approval, and artifact tools. Machine-readable schemas are generated into `schemas/forge-tools.schema.json`.

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

## Context and diff insight tools

Deterministic, container-free helpers backed by `@forge/insight` (no embeddings,
no model). See `docs/plans/context-and-diffs.md`.

- `forge_context_get` — rank the most relevant files for a goal and return
  paths, reasons, governing instructions, adjacent tests and package context
  (never file contents). The client decides what to read.
- `forge_diff_metadata` — compact, syntax-only metadata over the outgoing diff
  (changed files, exports, tests, config, migrations, possible secret exposure,
  risk areas, suggested hunks, stable hash) plus targeted `suggestedChecks`. The
  raw diff stays available via `forge_git_outgoing_diff` and must be inspected
  before any Git mutation.

## Capability cores with runtime wiring pending

These packages are implemented and unit-tested; their MCP surface is added once
it can be exercised against live Cloudflare runtime (principle: no experimental
or unvalidated path presented as production-ready).

- `@forge/browser-core/session` — interactive browser session model behind the
  intended `forge_browser_open/get/interact/capture/close`.
- `@forge/app-actions` — generic structured application-action discovery,
  calling, journeys and assertions with payment/admin/identity guardrails.
- `@forge/evidence` — versioned evidence model with explicit states and hashing;
  a screenshot can never be marked `passed`.
- `@forge/cost` — usage counters, budget thresholds and compute gating for
  response metadata and `forge_workspace_create`.

The checked-in fixture (`apps/fixture-catalog`) and
`tests/e2e/acceptance.test.ts` prove the composed workflow repository-locally.

## Credentials, recovery, and deployment

- `forge_credential_list`, `forge_credential_create`, `forge_credential_update`, `forge_credential_delete`, `forge_credential_switch`, and `forge_credential_validate` manage tenant-scoped encrypted provider profiles. They never return a secret or ciphertext.
- `forge_workspace_reconcile` reads the checkout and reports whether Forge has recorded the current commit as pushed. Run it after reconnecting before continuing an interrupted task.
- `forge_workspace_prove` returns a single receipt from the actual repository: immutable base, observed and recorded Git state, changed paths, worktree/outgoing hashes, and per-file filesystem/HEAD hashes.
- `forge_workspace_checkpoint`, `forge_workspace_restore`, and `forge_work_export` provide provider snapshots and a persisted recovery-patch escape hatch. Restore refuses to overwrite newer dirty or unpushed work.
- `forge_files_write` replaces one file only after a same-workspace read-after-write verification and a required automatic checkpoint.
- `forge_capabilities` is the stable session capability and approval manifest; `forge_process_get` returns the real status of a workspace-owned process, while `forge_process_stop` and `forge_check_cancel` stop only that explicit workspace-owned process.
- `forge_cloudflare_deploy` runs `pnpm exec wrangler deploy` only after approval, using the selected validated Cloudflare profile as an ephemeral command environment. It supports an optional Wrangler environment and config path.

Push remains approval-gated. Forge can reliably report local unpushed work, but it must not automatically publish a branch without the authenticated user's explicit approval.
