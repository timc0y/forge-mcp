# Simple

## Reality

- ChatGPT, often on a phone, authors GitHub source, plans, research and content,
  and sees public pages. It cannot loop, poll, retain opaque IDs or recover partial
  sequences. Agent support must preserve this user path.
- Distribution: MIT source and self-hosting for others; the maintainer hosts Forge
  privately for `timc0y` (owner decision, 24 October 2026). Each operator creates
  their own GitHub App and Cloudflare resources. No public hosted offer or billing.
  `FORGE_ALLOWED_LOGINS` admits explicit accounts; missing/invalid denies all.
  Preserve tenancy. Every request/approval uses the stored GitHub App user token,
  intersecting human and App grants; installation-wide tokens/IDs cannot authorize.
- GitHub holds repository truth. Forge holds identity/OAuth, frozen approvals, capture counts and anonymous
  inference meters, without a repository mirror or persistent semantic index
  ([source](./worker/src), [schema](./worker/migrations)).
- Hosting/rendering/JEV cost resources. Measure request/stage bytes, calls and
  usage. Per-person daily capture quotas and shared inference call/concurrency
  caps are not monetary guarantees. Never refund unknown paid attempts; missing
  usage does not prove zero provider charge.
- Tool/schema/instruction changes need a server-version release and client
  refresh/re-scan. [Operations](./docs/operating-forge.md) owns deployments;
  [release status](./docs/going-live.md) owns remaining proof.

## Preserve

- Eager GitHub durability: every successful write is already committed, with branch,
  SHA and URL. Return `unchanged` for an identical tree; never force a moved ref.
- Human-meaningful addresses survive summarisation; opaque IDs stay internal.
  Evidence arrives with its call. Results state what happened, whether GitHub
  changed, receipts, limits and at most one usable next action. No success wrapping
  terminal failure, or unusable IDs/removed tools.
- Merge/discard approval outlives chat: one evidence-bearing URL completed
  server-side, no polling. Preserve repository-scoped authority, credential
  isolation and expected-state conflict checks.
- Keep five tools without hidden mode/action expansion. Catalog bytes recur every
  turn. Remove unnecessary tools before adding guidance to avoid them.
- [Context engine](./docs/plans/context-engine.md) owns the active architecture:
  immutable snapshots, bundled format-owner parsers, exact-SHA GitHub checks,
  one configured JEV route and request-local evidence. One implementation per
  operation; no source/model/parser fallback chains or heuristic semantic success.
  Expose failed stages and valid partial/durable results. No hosted indexing,
  docs, security, reranking or alternate inference service.

## Current boundary

Hands author on GitHub; eyes return inline public-page captures. Ordinary edits
write the default branch; review uses one fixed `forge` branch/draft PR per repo.
Forge does not execute, build, test, serve, host or deploy code; T3 Code owns
execution. Repository CI can react independently to commits.

Capture is separately restricted to consenting `FORGE_CAPTURE_ALLOWED_LOGINS`; empty
denies before quota/provider work. Enabled users retain arbitrary public URLs.
Provider DNS/redirect/subrequest isolation is unproven: retire the restriction only
with provider proof and an explicit release. No private browsing/crawl/gallery or
capture store. Source, App grants, deployment smoke and fresh-client/account proof
are separate.

## Ordinary paths

- Blobs → tree → commit → expected-head GitHub update. Reapply only forward moves
  with complete unchanged-path proof. No Forge locks, leases or model-invented
  idempotency keys. Conversation chooses direct/review; commit/PR
  text describes it. No path classification, intent names, change IDs or session state. Legacy `forge/*` collisions are refused and named for
  deliberate cleanup; comparing then automatically deleting can race a new commit.
- Compare `base...head` for differences, divergence, discard safety and merge
  contents. Incomplete search or missing checks never prove absence or success;
  exact committed source remains authoritative and names its provenance.
- Capture: one public URL, one Cloudflare `/snapshot` call per viewport, images in
  the initiating response. Merge/discard uses the frozen approval receipt.
- JEV evaluates bounded trees, paths, diffs, hygiene candidates and judgments.
  Hygiene labels are prompts, weaker than compiler/static-analysis/CI evidence.
  Private-source processing needs explicit policy/processor disclosure. No
  background embeddings or repository execution.

## Proof

- `pnpm check`: TypeScript, Vitest and Node fixtures. Invariants require exactly five
  tools, no removed-tool guidance, lead instructions ≤512 characters and smoke
  aligned with `SERVER_VERSION`.
- [Self-hosting](./docs/self-hosting.md): config/disposable setup checks.
- After authorised deployment, run `worker/scripts/smoke.sh` against production;
  after metadata changes, refresh/reconnect and start a new conversation.
- [Release status](./docs/going-live.md) owns phone/client and self-host journeys.
  Each call must stay useful if chat stops; App grants, CI and held-out JEV
  relevance need separate proof.

## Reconsider when

- Execution is needed with no other route; only then reconsider workspace/
  container/capacity/process/recovery/mutation-queue machinery.
- Five tools cannot express a real need, or two proposals must coexist.
- GitHub cannot arbitrate a write, or change reads cannot cover arbitrary refs.
- Private/authenticated capture is needed; one page is insufficient and a crawl
  earns its workflow/store/gallery; volume defeats daily limits.
- People repeatedly ask the maintainer to host Forge for them; paid/public hosting
  would need a separate decision covering demand, spend, billing and support.

Failure and review evidence: [history](./docs/research/forge-history-tool-learnings.md).
