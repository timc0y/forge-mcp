# Forge — state of play, 29 July 2026

Handover for whoever picks this up next. Written at the end of a session that landed ten
commits, all deployed and pushed. Read this before changing anything in the workspace or
merge paths.

## What Forge is meant to be

A remote MCP server used from **ChatGPT** to develop real software: read a repo, edit files,
run tests, open a pull request. The design thesis is **remote-first**: `forge_edit` commits
straight to GitHub through the Git Data API, so an edit either lands on origin or does not
happen. The container is a cache of what is already on GitHub, never the source of truth.

The whole programme exists because of one incident: work was reported to a user as "on the
Forge branch", was never pushed, and was lost when the workspace was reaped. Everything below
follows from refusing to let a tool state something it has not established.

## What is done, and verified live

Ten commits, `5d7d34f..23ff741`. The end-to-end flow was exercised against real GitHub on
29 July — not just unit tests — and every step passed:

| Step | Verified |
|---|---|
| `forge_start` | branch on GitHub before any workspace; confirmed independently via the GitHub API, not by trusting the tool's own response |
| `forge_workspace_create` | **adopts** that branch rather than cutting `forge/<hex>`; `branch` came back equal to `requestedRef` |
| `forge_files_read` | `source: "github"`, served from the branch tip; `sizeBytes` describes the returned slice, not the whole file |
| addressing | resolved from a bare branch name, no workspace id anywhere |
| `forge_edit` | `committed_remote`, `on_remote: true`, commit URL returned |
| `forge_shell` | container synced to the new commit, clean tree |
| `forge_merge` | `feature_branch_on_origin: true`, `staged_ref` = the feature branch itself, **no push** |

That last row matters most: the staging push that produced the recurring HTTP 403 is gone.

Also landed: seven unused packages and the provider router deleted; the read-before-overwrite
guard now **fails closed** when GitHub truncates a large tree (it previously degraded open, so
on a big enough repo it silently stopped guarding); five recurring bug classes turned into
executable tests.

## THE open problem — read this first

**Provisioning takes about six minutes. The MCP transport aborts at sixty seconds.**

Two measurements from `mcp_tool_calls`: `forge_workspace_create` completed in **374,855 ms**
and **320,000 ms**, and *succeeded* both times. The client gave up at 60,000 ms.

So the first call of every session against a cold repository times out for the caller while
completing for the server. The agent learns nothing; a workspace it does not know about
becomes `ready` minutes later and holds a slot.

This single fact accounts for:

- the 62% failure rate on `forge_workspace_create` (15 of 24 calls)
- a fifteen-call quota retry storm — the agent never saw a success, so it kept asking
- stranded `ready` workspaces, which then blocked migration 0027
- three workspaces open on one branch
- `wait_budget_ms` accepting up to 110,000 ms, a value the transport can never honour

They are one fault, not five. Earlier work made the storm visible and the refusal actionable,
which was right, but treated symptoms. **Nothing an agent does can succeed when the operation
it waits on outlives the connection by a factor of six.**

### What to do about it

The target is not merely a stateless `runJob`. It is that **no tool blocks longer than the
transport allows**. `forge_workspace_create` should return a handle immediately and let the
caller poll, or stop being a blocking call.

**Measure before designing.** Take several timings, warm and cold, and split provision from
clone from install. The right fix differs completely depending on which stage dominates —
non-blocking create, pre-warming, or not provisioning a container until something is actually
run. Note that reads already come from GitHub and the branch is already cut on GitHub, so it
is a genuine question whether a session needs a container before its first command at all.

## Also outstanding

1. **`forge_branches` deletes a branch a live workspace is sitting on.** Reproduced by
   accident during the smoke. "Merged" says the commits are preserved; it says nothing about
   whether something is still using the ref. Deletion should consult `listSlotOccupants`
   (which carries `repository` and `currentBranch`) and refuse, or require `force`.
2. **`wait_budget_ms` advertises an unreachable maximum** — see above.
3. **157 `ForgeError` sites still state no cause and no next action.** An audit found 182 of
   231; packages have been fixing their own as they touch them. `ALLOWLIST_C` in
   `tests/unit/invariants.test.ts` is the work list and should only ever shrink.
4. **Tool catalogue: 43 tools, ~44.8 KB re-sent every turn.** A collapse to ~15 is designed
   but **deliberately deferred** — see the warning below.
5. Smaller: `forge_shell` has no `git push` denylist; unrecognised long-command output has
   not been checked for whether head or tail survives; each read costs three GitHub calls to
   resolve a tree, uncached across calls in a session.

## Decisions for the owner, not for an agent

- **Stranded workspaces.** Duplicates on `timc0y/EasyRoads` `forge/3adc07ad3283ce46` block the
  partial UNIQUE index that migration 0027 wanted. Clearing them means destroying `ready`
  workspaces. Not a migration's call to make quietly.
- **Two unmerged probe branches** on `timc0y/forge-mcp`: `forge/1df5442aee748cb4`,
  `forge/5309e86c5e7c1634`.
- **An open PR** from the smoke on `forge/smoke-full`, awaiting an approval link.

## How to work on this repo

**Use the production log, not intuition.** `mcp_tool_calls` in D1 holds redacted request and
response payloads. Three of the most valuable findings came from querying it; none came from
the test suite. Query it before believing anything about what agents actually do.

```
pnpm wrangler d1 execute forge-production --remote \
  --config ../../infra/wrangler/forge.jsonc --command "<sql>" --json
```
Set `CLOUDFLARE_ACCOUNT_ID=04d3e478b1ddf0f5147120cacbf430de`.

**Check for live sessions before deploying.** A deploy on 28 July landed mid-session, removed
a parameter the running agent was holding, and deadlocked it — every tool returned an
ambiguity error, including the one that could have cleared the ambiguity. Query
`mcp_tool_calls` for activity in the last fifteen minutes first.

**The five invariants** are enforced by `tests/unit/invariants.test.ts`. Every bug in this
session was an instance of one:

- A. no output field that no input anywhere can accept
- B. every schema default resolves to something real
- C. no success envelope carrying a failed state; no error without a cause AND a next action
- D. no agent-facing string naming a tool that is removed or does not exist
- E. every field describes the object returned beside it

**Beware tests that pin a literal.** Two were found holding bugs open: one asserted a removed
tool name, one pinned a migration count. Assert the property, not the value.

**Gate:** `pnpm check` (typecheck, 592 tests, schemas, boundaries). `pnpm catalog:measure`
reports the real `tools/list` wire bytes — the generated schema file omits `outputSchema`,
`annotations` and `_meta` and cannot measure the true cost.

`tests/unit/scripts-integrity.test.ts` is flaky under parallel load; it shells out with
`execSync`. Its three checks already run as their own `pnpm` steps, so it may be redundant.

## A warning about deleting tools

Two days of logs proved a confident deletion list wrong twice. `forge_observer_workspaces`
was marked operator-only; it is the **only** address-free tool, and it is what let an agent
recover when addressing broke mid-session. The four task tools were dismissed as dead weight;
they had fifteen calls, thirteen successful.

Do not cut on aesthetics. Get a week of real traffic first, then cut on evidence.
