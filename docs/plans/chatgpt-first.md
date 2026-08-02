# ChatGPT-first workflow

Status: task and insight cores are implemented. Evidence, structured app actions,
and cost controls remain proposals; Cloudflare runtime wiring is tracked in the
sibling plans.

## Goal

Make a normal ChatGPT conversation behave as though it has a persistent coding
task, GitHub-native repository reads and edits, an on-demand Linux executor,
build and test execution, a dev server, a private preview, browser evidence,
GitHub review workflows, and compact context that survives reconnects. ChatGPT
stays the reasoning agent; Forge supplies guarded repository access, ephemeral
execution, state, and evidence.

## The intended coding workflow

1. `forge_task_create` — durable task (goal, base ref, decisions, non-goals,
   likely paths). No container.
2. `forge_context_get` — bounded, deterministic file ranking. No container.
3. `forge_start` a guarded branch on GitHub, then attach one lightweight
   workspace with `forge_workspace_create`. No executor is allocated yet.
4. `forge_files_read` the ranked files; commit one coherent change with
   `forge_edit`. These operations use GitHub directly.
5. `forge_diff_metadata` → run only the `suggestedChecks` that matter, narrow
   first.
6. `forge_shell` or `forge_deps_install` allocates the ephemeral executor when
   checks are actually needed; use `forge_preview` or `forge_preview_expose` for
   a running service.
7. Structured journey against the preview; browser session for phone/desktop
   evidence.
8. `forge_task_get mode:summary` to survive context compression / reconnect.
9. Re-check `forge_diff_metadata`, then call `forge_merge` to open the draft PR
   and return the human approval link. There is no container commit or push step.
10. `forge_workspace_destroy`; preview revoked; task and evidence remain
    retrievable via `forge_task_get`.

Host-facing recipes (plan / UI / bug / resume) that ChatGPT can follow without
a strong session: [`../mcp/project-workflows.md`](../mcp/project-workflows.md).

## Principles honoured

Cheapest sufficient action; one workspace per coherent task; no executor for
repository reads, edits, diffs, history, branches, PRs, review of a deployed URL,
docs search, or reasoning; browser use deliberate; narrow checks before broad;
compact summaries never replace raw evidence and diffs; executor files never
become GitHub changes except through an explicit `forge_edit`.
