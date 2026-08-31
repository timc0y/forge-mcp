# Simple

## Reality

- Users: anyone with a GitHub account — an open research preview. Each installs
  the GitHub App themselves, so each brings their own credentials and their own
  GitHub rate limit. Tenancy is therefore load-bearing, not inert.
- Client: an ordinary ChatGPT conversation, often on a phone. It is not an agent.
  It cannot loop, poll, retain an identifier across turns, or recover from a
  partial sequence. Codex and Claude may connect to the same surface but must not
  be the surface it is designed for.
- Purpose: think of something and have it become real in GitHub — repos, plans,
  research, code, content — and look at rendered pages with real eyes.
- Durable plane: GitHub. Forge holds no copy of repository state. What Forge
  stores is identity, approvals, capture artifacts, and receipts.
- Cost: GitHub work is metered per user by GitHub itself and costs Forge nothing.
  Page capture is the only user action that spends Forge's money, so it is the
  only action with a number on it. What keeps an open preview affordable is a
  daily ceiling per person, not a gate at the door: a limit degrades for one
  person on one day, where a gate refuses everyone who does not know somebody.
- Compatibility: only the tools currently advertised to ChatGPT. The published
  catalog is a frozen snapshot until re-scanned, so a tool change is a release
  event, not an edit.

## Preserve

- Eager GitHub durability: no success response may describe an unsaved file.
  Every write receipt carries branch, commit SHA, and URL.
- Semantic addressing: everything the chat must carry is human-meaningful and
  survives summarisation. Opaque identifiers stay internal.
- Approval outlives the chat: one URL, completed server-side, no polling.
- Evidence arrives with the call that created it.
- Honest results: what happened, whether GitHub changed, the receipt, the
  limitations, and at most one next action. Never a success envelope wrapping a
  terminal failure, and never an identifier no public tool accepts.
- Catalog budget: the tool catalog is re-sent every turn. Bytes there are paid
  on every message before the model reads anything.
- Repository-scoped authorization, credential isolation, and approval gates on
  the two lossy acts.

## Current boundary

Two organs. **Hands**: durable authoring in GitHub. **Eyes**: capture of
already-public URLs. Five tools. Ordinary edits can update the default branch.
Work that needs review uses the repository's one fixed `forge` branch.

Forge does not run, build, test, serve, or deploy code. T3 Code owns that.
Forge hosts nothing.

## Ordinary paths

- Write: blobs → tree → commit → guarded ref update. Ordinary work goes to the
  default branch. Proposed work goes to the fixed `forge` branch.
- Any question about difference: `compare base...head`. It answers the diff,
  whether a change is safe to discard, whether it has diverged, and what a merge
  would contain.
- See: one URL, one Cloudflare `/snapshot` call, images returned inline with the
  call that asked for them. No crawl, no gallery, no artifact to fetch later.
- Land or lose: one approval receipt carrying the evidence for the decision,
  completed server-side.

## Precedents

### No executor

- **Need**: run and verify code from a chat.
- **Tempting complexity**: ephemeral containers, workspace lifecycle, capacity
  slots, process management, recovery tools.
- **Observed native fact**: nearly every production failure in this repo's
  history traces to compute holding state GitHub did not — lost workspace IDs
  (`5377975`, `bd8d130`), local-only edits a reaper could erase (`ca0a99a`),
  commands dying in the transport while continuing remotely (`9c78d0f`). Each
  fix was a mitigation; the cause remained and kept generating recovery tools.
- **Simple solution**: delete the execution plane. T3 Code runs code.
- **Why sufficient here**: authoring and capture need no computer that holds the
  repository.
- **Invalidation condition**: a user needs to run code and has no other way to.
- **Concepts avoided**: workspace, executor, container, slot, capacity, process,
  deferred execution, divergence, checkout recovery, mutation queue.

### A tool it can see is a tool it will call

- **Need**: keep the model choosing correctly.
- **Tempting complexity**: instructions and error messages that tell it not to.
- **Observed native fact**: the catalog reached ~64 tools, was cut to 34, regrew,
  was cut to 38 (`79bf6fc`). Every subsystem failure produced a public recovery
  tool, and the larger surface then produced selection, ordering, and guidance
  failures. Guidance naming removed tools regressed four separate times.
- **Simple solution**: remove the tool. Five remain, and none takes a mode or
  action parameter — a mode is a tool the model has to pick, wearing a disguise.
- **Why sufficient here**: a capability the model cannot see costs nothing per
  turn and cannot be misselected.
- **Invalidation condition**: a real user need has no expression in the five.
- **Concepts avoided**: recovery sprawl, tool-selection guidance, catalog churn.

### Optimistic concurrency, no locks

- **Need**: two writes must not silently clobber each other.
- **Tempting complexity**: leases, mutation queues, idempotency keys the model
  invents.
- **Observed native fact**: GitHub already refuses a non-fast-forward ref update,
  and the merge endpoint returns 409 when `sha` no longer matches the head.
- **Simple solution**: every mutating call carries the state it expects. On a
  moved ref, re-apply onto the new head; raise a conflict only when another
  commit touched a path this write also touches. Never force. An identical tree
  produces no commit and reports `unchanged`.
- **Why sufficient here**: there is one writer plane and GitHub arbitrates it.
- **Invalidation condition**: a write path that GitHub does not arbitrate.
- **Concepts avoided**: locks, leases, model-supplied idempotency keys.

### One branch means one pending decision

- **Need**: planning work must become repository truth without a forgotten pull
  request, while proposed implementation still needs review.
- **Tempting complexity**: classify paths, name branches from each intent, or
  keep session state.
- **Observed owner decision**: the model knows whether work needs review from
  the conversation. A repository needs no more than one pending Forge decision.
- **Simple solution**: an ordinary edit updates the default branch. A proposed
  edit uses the fixed `forge` branch. Later proposed edits continue it.
- **Why sufficient here**: the commit message and pull request describe the
  work. The branch only records that Forge made it.
- **Invalidation condition**: users need two independent Forge proposals open
  in one repository at the same time.
- **Concepts avoided**: path classification, branch naming, change ids and
  session state.

## Proof

- `pnpm check`
- Focused `pnpm test`
- `pnpm schemas:check`
- Catalog budget test and guidance-integrity lint must both stay green.
- The real proof: from a phone, an idea becomes a repo with documents in it, a
  change is made and diffed, a public page is captured, and the change is merged
  or discarded — each step useful even if the chat sends nothing further.

## Reconsider when

- Someone needs to run code inside Forge again.
- Someone needs a private or authenticated URL captured.
- Looking at one page at a time stops being enough, and crawling a whole site
  earns back a workflow, an artifact store, and a gallery to hold the overflow.
- Comparing two arbitrary refs is needed, rather than reading a change.
- Capture volume makes the daily ceiling insufficient to hold cost.
- The preview stops being free, which turns billing, refunds and support into
  obligations this design has never carried.
