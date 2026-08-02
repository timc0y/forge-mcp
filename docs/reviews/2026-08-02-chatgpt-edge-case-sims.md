# ChatGPT conversation traps (2 Aug 2026) — post–EasyRoads autopsy

Simulated user → ChatGPT → Forge MCP transcripts against contracts that
survived Conv A–AE / the 1 Aug flaw list. Several were still open after the
lazy-`requested` observer fix.

## Trap AF — Omitted screenshots point at a missing field (high) — FIXED

**Transcript**

1. User: “Review these 10 routes at phone and desktop.”
2. Agent: `forge_review` / `forge_preview` with many cells.
3. Forge: `omittedImageCount > 0`; structured `evidence[]` has no
   `screenshot.artifactId`.
4. `nextStep` previously said fetch `evidence[].screenshot.artifactId`.
5. Agent invents artifact ids or loops `forge_artifact_get`.

**Fix:** `nextStep` steers to `galleryUrl` or a smaller re-run; explicitly says
evidence rows have no `screenshot.artifactId`.

## Trap AG — `workspace_id` alias from catalog wording (med) — FIXED

**Transcript**

1. User: “Use workspace ws_… and run tests.”
2. Agent sends `{ workspace_id: "ws_…" }` because receipts/catalog say
   `workspace_id`.
3. Handlers only read `workspace` → empty address → wrong/ambiguous resolve.

**Fix:** `workspaceAddress()` accepts `workspace_id` as an alias for
`workspace` (ws_ id or owner/repo#branch).

## Trap AH — Unsafe merge advertises `force:true` (high) — FIXED

**Transcript**

1. User: “Merge PR #12 if possible.”
2. Status shows failing checks.
3. Merge error said “Fix these, or pass force:true with a reason.”
4. Agent invents a reason and requests override approval.

**Fix:** Message requires fixing blockers first; `force:true` only when the
human explicitly asks to override.

## Trap AI — Resume after dead workspace is silent (med) — FIXED

**Transcript**

1. User: “Resume task_… after compression.”
2. `forge_task_get mode:resume` remembers a reaped workspace; lookup fails.
3. Receipt had `workspace: null` and reused stale handoff `next_step`.
4. Agent invents a new branch or retries the dead id.

**Fix:** `workspace_unavailable: true`, remembered branch/id, and an explicit
observer → reuse/create `next_step`.

## Trap AJ — Alternating observer tools dodge stop-polling (med) — FIXED

**Transcript**

1. User: “Why is this still requested?”
2. Agent alternates `forge_observer_workspace` and `forge_observer_activity`.
3. Per-tool identical-success detector never trips.

**Fix:** Activity receipts carry lazy lifecycle guidance and a cross-tool
`forge_observer_*` storm diagnostic.

## Trap AK — Wrangler via `forge_shell` invents deploy URLs (high) — FIXED

**Transcript**

1. User: “Deploy with Wrangler.”
2. Agent: `forge_shell` `npx wrangler deploy` (after approval).
3. Exit 0 + workers.dev in stdout → agent claims deploy without
   `deploy_receipt.verified_url`.

**Fix:** Wrangler deploy shell/async/wait receipts steer to
`forge_secret_*` → `forge_deploy` and forbid inventing URLs from logs.

## Trap AL — Review preview capacity invites diff-only approve (med) — FIXED

**Transcript**

1. Human opens approval preview; slots exhausted.
2. Message said “approve on the diff alone.”
3. Reviewer/agent skips visual evidence without an explicit accept.

**Fix:** Destroy idle workspace and retry; diff-only only if the human
explicitly accepts.

## Still open

| Trap | Severity | Notes |
| --- | --- | --- |
| AM — Default `ref: main` on non-main repos | med | `forge_workspace_create` schema default; create error already steers `forge_branches` / `forge_start` |
| AN — Owner literally named `forge` | low | Pass `owner/repo#branch`; documented in workspace-resolve |
| AO — Token-only deploy without pinning account | med | `forge_secret_accounts` says confirm; deploy may still succeed with `account_id:null` |
| AP — First executor wake is error-shaped | med | `FORGE_WORKSPACE_NOT_READY` works but feels like failure; success+poll recipe still open |
| AQ — Long `forge_deploy` then only `process_wait` | med | Start receipt already steers retry deploy; wait-on-shell path now covered; pure deploy wait still depends on process command metadata |

Executable sims: `tests/unit/chatgpt-conversation-sim.test.ts` Conv AF–AL.
Basic short-session traps (destroy-continue, operation poll, nested list paths):
`docs/reviews/2026-08-02-basic-chatgpt-session-traps.md` (Conv AM–AS).
