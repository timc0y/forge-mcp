# Basic ChatGPT session traps (2 Aug 2026)

Simulations of short, ordinary ChatGPT sessions — typo fixes, “what’s in the
repo?”, open a PR, destroy then continue — that still confused the model after
Conv A–AL.

## Trap AM — Destroy then continue on the old `ws_` id (high) — FIXED

**User:** “Destroy the workspace.” … “Actually add one more sentence.”

**Bad sequence:** `forge_workspace_destroy` → reuse old `workspace_id` →
`forge_edit` / `forge_files_read`.

**Fix:** `liveControlPlaneCoordinator` hard-refuses destroyed/destroying for
GitHub CRUD; destroy receipt includes `next_step` + recreate actions;
`workspace_get` / allowed actions steer recreate.

## Trap AN — Poll `forge_operation_get` forever after create (high) — FIXED

**User:** “Fix the typo in README.”

**Bad sequence:** `forge_workspace_create` → see `operation_id` → loop
`forge_operation_get` while status stays `accepted` with no process.

**Fix:** Processless create/destroy ops report `completed` once the workspace
is `requested`/`ready`/`destroyed`, with `stop_polling` and edit/recreate
`next_step`.

## Trap AO — Nested `forge_files_list` paths drop the directory (med) — FIXED

**User:** “What files are in docs/?” then “Read that README.”

**Bad sequence:** list `docs` → entry `README.md` → read `README.md` (wrong).

**Fix:** Entries always expose full repo-relative `path` (plus `name`); list
receipt says not to strip the prefix.

## Trap AP — `forge_start` while live still cut a stray branch (med) — FIXED

**User:** “Open a PR” after a workspace already exists.

**Bad sequence:** `forge_start` always → new `forge/*` ref + reuse message.

**Fix:** Detect live occupants *before* `createBranchRef`; return
`created: false` and reuse guidance without cutting.

## Trap AQ — Default `ref: main` on non-main repos (med) — FIXED

**User:** “Fix the typo in owner/repo.”

**Bad sequence:** `forge_workspace_create` with schema default `main` → 404.

**Fix:** `ref` optional (omit → GitHub default branch); if explicit/legacy
`main` 404s, fall back once to the repository default.

## Trap AR — Docs-only edit pushes full test install (med) — FIXED

**User:** “Fix the typo in README.”

**Bad sequence:** `forge_edit` → receipt says run `forge_shell` → deps install.

**Fix:** Docs/markdown-only paths steer `forge_diff_metadata` → `forge_merge`
and say tests are optional.

## Trap AS — “PR opened” when only approval was queued (med) — FIXED

**User:** “Add a sentence, then open a PR.”

**Bad sequence:** `forge_merge` → agent claims a PR URL.

**Fix:** Receipt includes `approval_required: true`, `pr_url: null`, and
wording that this is human approval, not an opened PR.

## Still open for basic sessions

| Trap | Severity | Notes |
| --- | --- | --- |
| AT — First shell wake is error-shaped | med | `FORGE_WORKSPACE_NOT_READY` still feels like failure |
| AU — `forge_task_create.base_ref` still defaults to `main` | low | Align with create’s optional default-branch resolve |
| AV — `forge_merge.pr_base` / diff `base` default `main` | low | Same class as AU |

Executable sims: `tests/unit/chatgpt-conversation-sim.test.ts` Conv AM–AS.
