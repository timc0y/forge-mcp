# ChatGPT conversation flaws (1 Aug 2026)

Simulated user → ChatGPT → Forge MCP transcripts against the live tool
contracts. Several traps were already closed (lazy create, quota storms,
install restart). These were still open and are fixed in the same change set
as the project-workflow prompts.

## Flaw 1 — Install wait budget contradiction (high)

**Transcript**

1. User: “Install deps and run the app on owner/repo.”
2. Agent: `forge_workspace_create` → `forge_deps_install`.
3. Forge: install still running; `next_step` said
   `Call forge_process_wait … timeout_ms >= 600000`.
4. Agent: one long wait (or invents larger waits / restarts install after
   transport abort).
5. Truth: `forge_process_wait` observes ≤30s per call; 600000 exceeds the MCP
   host timeout and contradicts the wait tool’s own schema.

**Fix:** shared `observationalWaitNextStep()` — always ≤30000, same
`process_id`, never restart. Used by deps reuse, shell managed-process start,
and coordinator receipts.

## Flaw 2 — “Get once” vs “get until ready” (high)

**Transcript**

1. User: “Run the tests.”
2. Agent: first `forge_shell` on a lazy workspace.
3. Forge: `FORGE_WORKSPACE_NOT_READY` — executor starting.
4. MCP instructions said “call forge_workspace_get **once**, then retry.”
5. `forge_workspace_get` said “Retry … **until** ready.”
6. Agent either gives up after one get, poll-storms without backoff wording, or
   opens a second workspace.

**Fix:** one recipe `EXECUTOR_PROVISIONING_NEXT_STEP` — poll get until ready,
retry the **same** execution tool, never create a second workspace. Wired into
executor wake errors, workspace get `next_step`, and MCP instructions/prompts.

## Flaw 3 — Duplicate workspace after ambiguity / compression (mitigated)

**Transcript**

1. Context compresses mid-task.
2. Agent loses `workspace_id`, calls create again for the same repo.
3. Quota / two slots on one branch.

**Mitigation:** resume prompt + instructions forbid duplicate create; wake
errors name “do not create a second workspace.” Hard enforcement (refuse
second live slot per repo/branch) is still a follow-up.

## Still open (not fixed here)

- First-execution provision can still take minutes; wake returns an error-shaped
  “not ready” rather than a success receipt with `operation_id` + poll interval.
- ~147 allowlisted `ForgeError` sites without cause + next action.
- Large tools/list catalog cost.

Executable sims: `tests/unit/chatgpt-conversation-sim.test.ts`.
