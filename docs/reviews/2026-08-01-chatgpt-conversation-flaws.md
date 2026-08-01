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

## Flaw 3 — Wrong order / edge cases (high)

| Wrong order | Agent invention | Fix |
| --- | --- | --- |
| edit/shell before create | Invents branch slug | Empty-open message: create first, do not invent branch |
| create twice for same repo | Three ready slots | `FORGE_WORKSPACE_CONFLICT` listing live addresses |
| `forge_start` while live | Opens second workspace | `next_step` steers reuse of existing addresses |
| merge then keep editing | Human approves old SHA | Merge `next_step`: no further edit; destroy |
| tools after destroy | “GitHub App is read-only” | Destroyed message: create again; keep commits |
| ambiguous `owner/repo` | Creates a third workspace | Ambiguity message forbids duplicate create |
| preview before deps / stale `preview_id` | Restarts server forever | Steer deps install; omit preview_id |
| invented `process_id` | Restarts install | PROCESS_NOT_FOUND → `forge_process_list` |
| merge with empty diff | No-op edit loop | Steer read → edit → merge |

## Flaw 4 — Multi-turn real use (high)

Deeper ChatGPT sessions (UI iteration, bugfix, PR submit, reconnect) hit
these next:

| Real-use trap | Agent invention | Fix |
| --- | --- | --- |
| Truncated `forge_files_read` | Whole-file `content` overwrite | Skip `rememberReads` when truncated; `next_step` forbids rewrite |
| `FORGE_FILE_CONFLICT` | Retry same replace + key | Re-read path + fresh `idempotency_key` |
| `forge_context_get` paths only | Invent file contents | `next_step`: read before edit |
| `forge_diff_metadata` | Invented `suggestedChecks` | `next_step` names real `riskAreas` / `suggestedHunks` |
| Re-call `forge_merge` while pending | Duplicate deferred rows | Replay existing receipt (`replayed: true`) |
| Approval still pending | Poll merge/PR in a loop | Echo URL; stop; retry once after human confirms |
| Dropped `task_id` after compression | Orphan task / new create | `forge_task_create` keeps `task_id` |
| Full `forge_workspace_get` dump | Burns context window | Default `compact: true` |
| `forge_shell` / `forge_preview` during install | Race `node_modules` | Hard refuse; wait the same install process |
| `forge_process_stop` mid-install | Start two installs | Steer list → one `forge_deps_install` |

## Flaw 5 — Local executor spiral (high)

| Spiral | Agent invention | Fix |
| --- | --- | --- |
| `sed` / redirects / `tee` via shell | “Done” without GitHub | **Hard refuse** → forge_edit |
| `git commit` / `git add` in shell | “Committed” | Prohibited like push |
| Green tests on executor-only edits | Feature shipped | Guidance: require `forge_edit` `commit_url` |
| Missing deps → shell-only `allowedNextActions` | Author via shell while installing | Always include `forge_files_read` / `forge_edit` |
| Soft “continue with ephemeral files” | Skip forge_edit | Single `durabilityNextStep()` recipe |
| Success loops with no GitHub change | Busy forever | **Φ-gate** (discrete Lyapunov): refuse after \(K\) successes without durable witness |
| Edit→test false positive on Φ-gate | Refuse mid-verify | Verify-budget \(B=6\) dwell credit after each witness |
| “Done” with no durable trail | Claim success from exit 0 | Causal witness chain tip/depth on receipts |

## Activity logging

Complete activity is D1 `mcp_tool_calls` (default for `forge_observer_activity`)
+ `/app/live`. No third-party analytics embed.

## Theory (experimental)

See `docs/research/progress-potential.md` — Durable Progress Potential, verify
budget, causal witness chain, Shannon thrash on tool streams.

## Still open (not fixed here)

- First-execution provision can still take minutes; wake returns an error-shaped
  “not ready” rather than a success receipt with `operation_id` + poll interval.
- ~140 allowlisted `ForgeError` sites without cause + next action.
- Large tools/list catalog cost.
- Φ still receipt-derived; bind to workspace DO fingerprint next.
- Φ-gate \(K\)/\(B\) may need production tuning against long verify loops.

Executable sims: `tests/unit/chatgpt-conversation-sim.test.ts` (Conv A–AE).
