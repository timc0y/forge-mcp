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

- Execution once kept state outside GitHub. Lost workspace IDs (`5377975`,
  `bd8d130`), reaped local edits (`ca0a99a`) and commands that outlived transport
  (`9c78d0f`) caused repeated failures. T3 Code now owns execution. Authoring and
  capture need no local repository copy. Reconsider if a user needs execution
  and has no other route. Do not restore workspace, container, capacity, process,
  checkout-recovery or mutation-queue machinery without that need.
- The catalog grew to about 64 tools, fell to 34, grew again, then fell to 38
  (`79bf6fc`). Recovery tools caused more selection and ordering failures;
  guidance named removed tools in four regressions. Five tools now remain,
  without mode or action parameters that hide more choices. Reconsider only
  when a real need has no expression in the five. Remove unnecessary tools
  rather than add instructions to avoid them.
- GitHub refuses non-fast-forward ref updates; merge returns 409 when `sha`
  differs from the head. Each write carries expected state. Reapply on a moved
  ref; raise a conflict when another commit changed the same path. Never force.
  An identical tree returns `unchanged` without a commit. GitHub owns concurrency;
  no locks, leases or model-invented idempotency keys. Reconsider for a write
  that GitHub cannot arbitrate.
- One repository has one pending Forge decision. Ordinary edits update the
  default branch; proposed edits continue the fixed `forge` branch. The model
  selects review from the conversation; commit and pull-request text describe
  the work. Do not add path classification, intent-based branch names, change
  IDs or session state. Reconsider when users need two independent proposals
  open in one repository.
- Fast semantic decisions need no server-side index. Vector databases, periodic
  repo indexing, and background embeddings workers add infrastructure that drifts
  out of sync with GitHub. TypeSafe Jev evaluates trees, paths, diffs, and security
  gates on the fly in ~70-200ms using a single non-autoregressive forward pass.
  Remote GitHub remains the sole source of truth; if Jev is unavailable or
  unconfigured, Forge degrades cleanly to exact matching and honest receipts.

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
