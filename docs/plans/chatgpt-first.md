# ChatGPT-first workflow

Status: cores implemented across task, insight, evidence, app-actions and cost;
Cloudflare runtime wiring tracked in the sibling plans.

## Goal

Make a normal ChatGPT conversation behave as though it has a persistent coding
task, a checked-out repository, a Linux terminal, safe reads and patches, build
and test execution, a dev server, a private preview, browser evidence, Git
workflows and compact context that survives reconnects. ChatGPT stays the
reasoning agent; Forge supplies execution, state, evidence and Git operations.

## The intended coding workflow

1. `forge_task_start` — durable task (goal, base ref, decisions, non-goals,
   likely paths). No container.
2. `forge_context_get` — bounded, deterministic file ranking. No container.
3. Attach one workspace (`forge_workspace_create`, `bootstrap` only when needed).
4. `forge_files_read` the ranked files; `forge_files_patch` a coherent change.
5. `forge_diff_metadata` → run only the `suggestedChecks` that matter, narrow
   first.
6. `forge_process_start` the dev server; `forge_preview_expose` a private URL.
7. Structured journey against the preview; browser session for phone/desktop
   evidence.
8. `forge_task_summary` to survive context compression / reconnect.
9. `forge_git_outgoing_diff` (inspect raw diff) → commit → push (approval) →
   draft PR.
10. `forge_workspace_destroy`; preview revoked; task and evidence remain
    retrievable via `forge_task_get` / `forge_task_summary`.

## Principles honoured

Cheapest sufficient action; one workspace per coherent task; no container for
review of a deployed URL, repository metadata, docs search or reasoning; browser
use deliberate; narrow checks before broad; compact summaries never replace raw
evidence and raw diffs; no default-branch pushes.
