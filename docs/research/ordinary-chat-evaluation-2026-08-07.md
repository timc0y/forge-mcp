# Forge ordinary-Chat evaluation

**Date:** 2026-08-07
**Scope:** the public ten-tool direct-chat facade, not Codex, Work, or an autonomous coding agent.

## Evidence labels

- **Documented** means stated by an authoritative OpenAI or Forge source.
- **Directly observed** means measured against `https://forge.timcoy.uk/mcp`, the checked-in handlers, or the local fixture.
- **Inferred** means a design conclusion from those sources.
- **Speculative** means a hypothesis that needs a fresh ChatGPT-host experiment.

## Research findings

| Finding | Label | Evidence and consequence |
|---|---|---|
| Custom MCP apps are selected from ChatGPT Apps and invoked by mention or the app picker. | Documented | [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in). The app must make each first call useful because selection is a user/model decision, not an agent workflow contract. |
| Full MCP write support is plan/workspace controlled and still beta; write calls can require confirmation. | Documented | [Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). Forge must preserve deferred approval and never assume a write prompt will be accepted automatically. |
| Published app metadata is a frozen snapshot until an administrator refreshes it. | Documented | [MCP app publishing](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). A source change alone does not repair a production ChatGPT catalog; redeployment and app refresh are separate operations. |
| OAuth without `offline_access` can lose access when the original authorization expires. | Documented | [MCP app OAuth configuration](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). Forge requests offline access, but a real ChatGPT reconnect test remains required. |
| ChatGPT memory is a relevance-oriented summary and is not guaranteed to retain every exact prior detail. | Documented | [Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq). Repository plus branch is safer recovery state than a workspace/process/task identifier. |
| OpenAI does not publish a contractual number of dependent MCP rounds or an ordinary-Chat MCP handler timeout. | Documented absence | The cited app/MCP documentation specifies setup, permissions, and metadata, but no guaranteed chain length or per-call budget. Forge should absorb orchestration server-side rather than rely on an unstated client limit. |
| GPT-5.6 Terra is not selectable in standard ChatGPT conversations; Sol is the relevant 5.6 target for ordinary Chat. | Documented | [GPT-5.6 in ChatGPT](https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt). Terra is relevant to Work, Codex, or API tests, not a standard-chat Sol-vs-Terra comparison. |
| Sol and Terra support MCP/function calling in their API model descriptions, but API context limits are not a promise about ChatGPT's injected context. | Documented | [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra). Do not infer ordinary-Chat tool-round behavior from API token limits. |
| The current source catalog is ten direct tools and excludes workspace, task, process, artifact, secret, and preview lifecycle tools. | Directly observed | `packages/mcp-core/src/index.ts`, `tests/unit/chatgpt-conversation-sim.test.ts`, and `pnpm check`. This is aligned with the product constraint. |
| Forge's GitHub-first edit path commits and verifies the remote SHA before success. | Directly observed | `apps/forge-edge-gateway/src/handlers/direct-chat.ts` and `tests/unit/direct-chat.test.ts`. This is the correct durability boundary. |
| The deployed MCP returned ten tools; the direct matrix reached all ten and all ten invalid probes were rejected. | Directly observed | `pnpm test:tools` against `timc0y/forge-mcp` on 2026-08-07. Required outcomes: 3 success, 6 permission failures, 1 expected edit precondition; invalid outcomes: 10 validation failures; tool/runtime failures: 0. |
| Production public-URL screenshot works in one call and returned three responsive captures with an attached-image message and a gallery URL. | Directly observed | `FORGE_TOOL_MATRIX_PUBLIC_URL=https://forge.timcoy.uk pnpm test:tools`; result: `PUBLIC_SCREENSHOT success`, “Captured 3 screenshot(s)… All are attached…”. The attached-image blocks themselves must be inspected in a fresh ChatGPT host. |
| The local fixture's browser UI and structured actions work without a second artifact call. | Directly observed | Local preview `http://localhost:4321`: DOM exposed four Add buttons; clicking Forge Cap changed 3 items/£46.00 to 4 items/£64.00; invalid product returned HTTP 400. |
| Direct Chat will reliably complete arbitrary dependent chains, retain IDs after compression, or resume a timeout without a user nudge. | Speculative | No fresh ChatGPT Sol host was available in this evaluation. Forge's own history strongly argues against depending on these behaviors; see `docs/research/forge-history-tool-learnings.md`. |

## Compact production traces

The matrix uses a fresh OAuth registration and MCP session per run. It reads the live `tools/list`, generates schema-shaped required and deliberately invalid arguments, and does not create a workspace or poll a legacy operation.

### Own repository

```text
tools/list -> 10 tools
forge_deploy       required=permission_fail invalid=validation_fail
forge_edit         required=validation_fail invalid=validation_fail
forge_environments required=success         invalid=validation_fail
forge_read         required=permission_fail invalid=validation_fail
forge_repositories required=success         invalid=validation_fail
forge_run          required=permission_fail invalid=validation_fail
forge_screenshot   required=permission_fail invalid=validation_fail
forge_search       required=permission_fail invalid=validation_fail
forge_status       required=success         invalid=validation_fail
forge_submit       required=permission_fail invalid=validation_fail
summary: required={permission_fail:6, validation_fail:1, success:3}
summary: invalid={validation_fail:10}
tool/runtime failures: 0
```

The own-repository write/read/run failures are authorization results from the
deployed GitHub App, not claims that the handlers failed. The production owner
token did not grant this app access to `timc0y/forge-mcp`, so no valuable branch
was created and no edit was attempted.

### Public URL screenshot

```text
forge_screenshot(target=https://forge.timcoy.uk, paths=[/], viewports=[phone,tablet,desktop])
-> completed
-> 3 screenshots captured
-> attached image content reported
-> signed gallery URL returned
```

## Journey matrix

Status meanings: **pass** = exercised and useful; **fragile** = exercised with a
known environmental or host limitation; **blocked** = not honestly executable
in this environment.

| Journey | Sol | Terra | Calls/IDs | Evidence |
|---|---|---|---|---|
| Discover repositories | fragile | blocked | 1 / none | Direct MCP `forge_repositories` succeeded; no ordinary Chat host; Terra unavailable in standard Chat. |
| Find/read design document | fragile | blocked | 1–2 / none | Handler and schema tests pass; production repo authorization blocked read. |
| Search unknown code path | fragile | blocked | 1 / none | Handler exists and invalid contract passes; production authorization blocked search. |
| Fragment edit / add plan / core-code edit | blocked | blocked | — | No authorized disposable write repository was available; do not fake a commit. |
| Remote commit verification | pass at source level | blocked | 1 / none | `commitFilesToBranch` result is verified before receipt; behavioral production write not authorized. |
| Resume by `owner/repo#branch` | pass at source level | blocked | 1 / none | Direct handlers use semantic `repository_ref`; host resume remains untested. |
| Bounded command | fragile | blocked | 1 / none | Production command path reached permission gate; async path has handler tests and status URL tests. |
| Over-budget command | fragile | blocked | 1 + URL / one operation ID | Server-owned operation/status implementation tested locally; real host timeout not tested. |
| Public responsive screenshot | pass | blocked | 1 / private IDs hidden from call | Production returned three captures and gallery URL; fresh ChatGPT rendering not tested. |
| Repository preview screenshot | blocked | blocked | — | Repository access prevented safe preview creation. |
| Environment discovery | pass | blocked | 1 / none | Production tool returned success without secret values. |
| Approved deploy / verified URL | blocked | blocked | — | No authorized environment/profile and no approval action was performed. |
| Submit for human review | fragile | blocked | 1 / approval URL | Production reached permission gate; deferred approval design is covered by handlers/tests. |
| Semantic recovery after interruption | pass at source level | blocked | 1 / repository or URL | `forge_status` accepts semantic targets; real interrupted operation unavailable. |

There is no honest Sol-vs-Terra ordinary-Chat comparison: Terra is documented as
not selectable in standard ChatGPT. There was also no fresh ChatGPT host session
available here, so model-selection, tool-catalog loading, image rendering,
approval cards, context compression, and retry behavior remain host risks.

## Ranked critique of the ten-tool surface

1. **Strong:** `forge_edit` is a deep capability: bounded fragment replacement,
   GitHub commit, remote verification, and semantic branch receipt in one call.
2. **Strong:** `forge_screenshot` absorbs preview/bootstrap/capture orchestration
   and returns inline evidence plus a durable gallery fallback.
3. **Strong:** `forge_run`, `forge_deploy`, and `forge_submit` keep executor,
   approval, and cleanup state private and return terminal/deferred receipts.
4. **Good:** `forge_read` and `forge_search` use GitHub directly, avoiding a
   workspace allocation for ordinary inspection.
5. **Good:** `forge_environments` exposes readiness and labels, not secret values.
6. **Risk:** the catalog still has ten choices for a host where OpenAI recommends
   narrow app outcomes; selection quality needs fresh direct/indirect/negative
   ChatGPT tests rather than source assertions alone.
7. **Risk:** `forge_status` is semantically addressable, but the host behavior
   after an asynchronous result is undocumented; the status URL must remain
   sufficient if ChatGPT stops immediately.
8. **Risk:** screenshot attachments are directly useful only if the ChatGPT host
   renders MCP image content. The gallery is the necessary no-follow-up fallback,
   but it still contains internal IDs inside a signed user-facing URL.
9. **Risk:** deployed app metadata can be stale after code changes. Production
   deployment and ChatGPT app refresh must be treated as part of release testing.

## Architecture decision

Keep exactly the ten direct capabilities public. Keep workspace, task, process,
artifact, browser, approval redemption, vault, and cleanup records private.
GitHub remains the durability boundary; executor files remain disposable. A
successful public call must return a useful receipt, evidence, or human approval
URL without requiring ChatGPT to poll or retain a control-plane ID.

## Unresolved risks requiring real ChatGPT-host testing

- Fresh ChatGPT catalog visibility and tool selection for direct, indirect, and
  compressed prompts.
- Sol tool-call depth and whether a one-call screenshot visibly renders all
  attached images.
- Approval-card behavior under Always ask, Important actions, and Never ask.
- OAuth refresh/reconnect after expiry and after a chat resumes.
- A user turn after a deliberately discarded branch/operation identifier.
- A command crossing the ChatGPT host's synchronous limit.
- Terra is not a standard-Chat target; test it only in the separate Work/Codex/API
  evaluation if that surface is in scope.
