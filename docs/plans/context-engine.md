# Forge context engine

Status: selected implementation plan, not implemented.
Owner instruction: Tim, 20 September 2026.
Source baseline: `main` at abbreviated commit `9b6c2c6`, inspected through Forge.

## 1. Decision

Build a **query-specific context compiler** inside Forge. Given a task, it gathers authoritative GitHub evidence, extracts structure, uses JEV to select the relevant evidence, and returns a small, source-addressable packet. ChatGPT should reason about the change, not write temporary scripts to discover files, walk imports, filter a JSON ledger, reconstruct a diff, or gather test failures.

Keep five public tools, GitHub-first durability, the existing human approval boundary and no repository execution plane. Replace responsibilities rather than adding parallel implementations.

### Dependency boundary

Retain GitHub, Forge's existing Cloudflare infrastructure, and **the explicitly requested JEV integration through one configured Cloudflare route**. JEV is externally hosted inference; this is not a claim of fully local AI or zero inference cost. No second inference provider is selected.

Do not integrate Context7, DeepWiki, Sourcegraph, grep.app, deps.dev, OSV's hosted API, ecosyste.ms, hosted rerankers, vector databases, documentation aggregators, or MCP gateways. Their free tiers do not change this decision. Public upstream repositories and documentation source hosted on GitHub remain available through the same GitHub adapter.

Open-source libraries bundled into Forge or run in a repository's existing CI are permitted. A package is not a hosted service. Do not automatically install packages, enable a paid GitHub feature, dispatch CI, or create new provider accounts.

This supersedes the earlier conversational federation/provider-cascade proposal. The [repository-intelligence research](../research/repository-intelligence.md) remains evidence about prior/current behavior, not a competing implementation queue. [Forge V1](./forge-v1.md) remains the historical reset record. [Product route](./product-route.md) continues to own commercial direction.

### What “no fallbacks” means

Each operation has one authoritative implementation and a typed result. It must never quietly substitute a different source, model, parser, revision, output mode, or level of certainty when that implementation fails.

- Scoped content search reads the pinned GitHub snapshot directly. Remove the GitHub-code-index-first/committed-archive-second cascade for this operation.
- JEV semantic operations use one transport and response contract. Missing configuration, timeout, missing answers and malformed output are explicit failures, not heuristic rankings wearing the same success label.
- Structural analysis uses the selected parser for that language. Unsupported syntax is reported as unsupported; no regex approximation is substituted as equivalent analysis.
- A requested source file remains an exact source read. Adding a question must not silently replace it with a lossy excerpt.
- Checks for an older commit cannot stand in for checks for the requested commit. Missing permission is unavailable, not zero failures.
- If a required stage fails, the requested result is unavailable/incomplete. Already acquired facts may be attached as partial evidence, with the failed stage prominent; they do not constitute successful completion of the requested semantic task.

Exact reads, semantic context, and CI evidence are different operations, not emergency replacements for each other. Ordinary token refresh, GitHub pagination, an explicit source redirect and SHA-fenced conflict handling are parts of their own protocols. Preserve them. Do not confuse removing fallbacks with deleting error handling, durable write receipts, approved rollback, or safeguards against lost writes.

No automatic retry loop in the new JEV pipeline. Return the error and any provider retry timing. A later explicit request is a new attempt. A commit that already exists must still return its durable receipt even if subsequent optional reporting fails.

## 2. Problems this replaces

The current source demonstrates the following work and ambiguity:

| Current behavior | Replacement | Source owner |
| --- | --- | --- |
| Global search chooses repository search from magic words in the query | Explicit intent resolution; a bare project name means repository discovery, not arbitrary code occurrences | `worker/src/tools.ts`, `worker/src/search.ts` |
| Reads use a moving branch and often omit an immutable source identity | Resolve the revision once and use that SHA throughout the request | `worker/src/read.ts`, `worker/src/repo.ts` |
| `paths + query` can turn requested contents into semantic excerpts | Exact selectors retain their contract; context selection is separately identified | `worker/src/tools.ts` |
| Scope search consults an unreliable code index and then downloads an archive | One bounded committed-snapshot search implementation | `worker/src/search.ts` |
| Archive decompression checks unpacked size after buffering the entire result | Streaming byte enforcement before retention/allocation exceeds the bound | `worker/src/search.ts` |
| Fixed line windows cut across functions and repeat irrelevant source | Parser-addressed symbols, document sections and structured records | `worker/src/read.ts`, `worker/src/jev.ts` |
| JEV transport detects providers from endpoint/key shapes and accepts alternative response wrappers | One configured transport, one documented wire adapter, explicit model identity | `worker/src/jev.ts` |
| Missing JEV values can acquire default confidence values | Required typed answers or an explicit error; no invented probability | `worker/src/jev.ts` |
| `verified`, `DEAD?` and `LIKELY GATE` invite overclaiming | Signature, syntax, declaration, executed check and semantic judgment are distinct evidence classes | `worker/src/tools.ts`, `worker/src/change-review.ts` |
| Post-commit notices do not consistently change the next action | Proven blocking errors lead to repair guidance; heuristics remain advisory | `worker/src/tools.ts`, `worker/src/repository-intelligence.ts` |
| ChatGPT reassembles instructions, implementation, callers, tests and plans | One task-shaped, budgeted evidence packet | Existing read/intelligence owners |

The plan does not assume that every candidate above is an exploitable defect. Characterize each behavior with a regression before replacement.

## 3. Architecture

```text
User goal / exact target
          |
GitHub authorization + immutable snapshot
          |
Exact source / syntax structure / GitHub check evidence
          |
Bounded candidate graph and evidence obligations
          |
JEV relevance + counter-evidence + sufficiency decisions
          |
Deterministic, diversity-aware context packing
          |
Compact packet with exact source anchors and explicit omissions
          |
ChatGPT reasoning -> bounded edit -> GitHub commit -> human review
```

No persistent code index, clone, workspace, generated repository mirror, embedding store, background crawler, scheduled indexing or autonomous task loop. Request-local data structures are temporary computation, not a second source of truth. A minimal map from a public dependency to its authoritative GitHub source is configuration, not an indexed copy of that source.

Keep transport orchestration in `tools.ts` thin. Extend the existing read, search, JEV and review owners. Introduce narrowly named modules for snapshot analysis, structure and packet packing only where that responsibility is actually new; move replaced logic rather than copying it. Do not build a general agent framework or a provider-plugin system.

## 4. Evidence contract and snapshot consistency

Every repository result must identify the requested repository, resolved commit, selected scope and coverage. Each evidence item needs:

- kind: `source`, `syntax`, `github-check`, `github-metadata`, or `jev-judgment`;
- source address: repository, SHA, path and exact line/byte range when applicable;
- coverage: complete for the named scope, bounded, unsupported, or unavailable;
- provenance: parser/tool version, check run/workflow identity, or JEV returned model and question-template version;
- limitations and unresolved dependencies needed to interpret it correctly.

Use a small internal schema and one compact representation. Do not repeat the same file text in both `files` and `searchResults`, repeat a long PR title on every evidence line, or print several versions of the same caveat. Preserve enough receipt state to resume after conversation compression. Measure what the MCP host actually exposes: do not assume transport-level structured data is invisible to model context.

A `complete` result always means complete for an explicit scope, not the whole repository by implication. A syntax tree is not a type-resolved reference graph. A string match is not a call edge. A configured script is not an executed test. A successful check does not prove all behavior correct. No universal repository health or AI safety score.

Resolve default/proposal heads once; use their SHAs for trees, contents, archives and comparisons. Check metadata may change while being read: include observation time and the exact tested SHA, without pretending it is an atomic GitHub-wide snapshot.

Accept GitHub repository, blob, commit and pull-request URLs directly. Resolve slash-containing refs using GitHub data rather than guessing URL segments. Return anchors that Forge itself accepts. For proposal work, make reading the actual proposal file possible, not just its patch or an accidental default-branch read. Resolve exact caller-supplied selectors before semantic routing; reject conflicting selectors instead of guessing.

Permissions and scope are deterministic. A failed private-repository lookup must never widen into public search. A `404` is not sufficient proof that a policy, private resource or capability does not exist.

## 5. Immediate structure without an index

### Selected parser policy

Use the existing TypeScript package's parse-only API for JS/TS/JSX/TSX. Do not execute source, load repository plugins or create a compiler program that resolves arbitrary filesystem/network inputs inside Forge. Extract declarations, signatures, literal imports/exports, source spans and syntactic call sites. Cross-file binding and reachability claims require the matching project/tool evidence described below.

Use the upstream Astro compiler for Astro structure, and the upstream Shopify Liquid parser for Liquid structure, after their request-runtime and source-span tests pass. These are format owners, not interchangeable fallbacks. Astro's current README explicitly warns about imperfect position data; reconstruct and verify every exposed source span against the original bytes. Until validated, do not offer range-based Astro edits. Report unsupported coverage instead of treating Astro as TypeScript.

Use a Markdown AST for headings, paragraphs, links and task lists. Use a maintained JSONC parser for configurations that actually allow comments, and a maintained YAML parser in safe data-only mode. Strict JSON remains strict where its format requires it. Reject duplicate/ambiguous configuration keys and bound YAML aliases. Do not label valid JSONC invalid merely because a filename ends in `.json`.

Selected implementation candidates:

| Library | Responsibility | Admission test |
| --- | --- | --- |
| `typescript` (already in repo) | JS/TS parse-only outline and spans | Worker bundle, parse-time and Unicode-span tests |
| `@astrojs/compiler` | Astro AST and embedded-source boundaries | Precompiled Wasm/runtime compatibility and exact span round trips |
| `@shopify/liquid-html-parser` | Liquid/HTML AST | Supported syntax and exact span tests against theme fixtures |
| `mdast-util-from-markdown` | Markdown section/obligation selection | Exact section offsets, fenced code and nested-heading tests |
| `jsonc-parser` | JSONC AST/locations and surgical data edits | Error reporting, duplicate-key policy and comment-preserving edits |
| `yaml` | YAML data/config parsing | Safe schemas, bounded aliases and original range preservation |
| `fast-check` (development only) | Property-based regression generation | Material coverage of selector, parser and edit invariants |

Pin approved versions, review licenses and lockfiles, and record bundle costs before installation. This table selects responsibilities; it does not claim the packages are already installed or compatible. Do not add Babel, Oxc, SWC and Tree-sitter as alternative JS parsers. Tree-sitter is reserved for a later, explicitly supported additional language, not runtime rescue when another parser fails. No general LSP server inside Forge.

### Useful first-class selections

Support natural requests for a symbol body, a file outline, the instructions applying to a path, a Markdown section, and a record identified by a JSON pointer or stable key. Execute structured selections with code, never generated JavaScript, shell, `eval`, SQL or arbitrary JSONPath scripts.

The large HeadteacherChat issue ledger is a concrete target: retrieve the complete object with ID `SR-755`, its status/action and source references without sending hundreds of unrelated issues to ChatGPT. A selector that matches several records must return ambiguity, not choose the first.

Inspect nested `AGENTS.md`/`SIMPLE.md` ancestry for the edited scope. Preserve mandatory constraints verbatim; do not reduce binding instructions to an unreliable AI paraphrase. Links from docs are evidence candidates, not authority to invoke tools or change scope.

### Memory and scanning

Use one snapshot acquisition/scan per scoped context request, shared by all its questions. Memoize identical reads only within that request. Never cache a moving branch as source truth.

Stream gzip/tar data, enforce compressed and unpacked byte ceilings while consuming the stream, and discard noncandidate bodies after extraction. Handle archive paths, symlinks and formats as untrusted input; never extract to an executable checkout. Release parser trees and Wasm allocations promptly.

Keep the existing 20 MiB compressed/40 MiB unpacked limits as initial ceilings, not guarantees that buffering them is safe. Benchmark concurrent requests: Workers memory is isolate-wide. Add per-file parse limits, retained-evidence limits, request deadlines and bounded GitHub concurrency before enabling structure over large repositories. A timeout flag alone cannot interrupt an unbounded synchronous parser. Unsupported/oversized scope must be explicit.

## 6. JEV as a constrained semantic controller

JEV is a decision model, not a code generator or summarizing LLM. Its official primitives are Choice, Score and Noul. Multiple atomic questions can share a state; compose their results in code. Choice supports up to 255 options, Score has ordered levels and can return a fractional expectation, and Noul has no separate confidence field. Preserve these distinctions. [R1–R3]

### One transport and one contract

Keep the deployment's selected Cloudflare route. Remove the direct TypeSafe endpoint alternative, hostname/key-prefix provider guessing and silent switching between wire contracts. Establish the exact current Cloudflare request/response with a sanitized real contract fixture before replacing the adapter. Do not assume the direct TypeSafe API envelope is identical.

Validate required answer IDs, matching types, legal choices, finite probabilities, distribution completeness/sums and Score ranges. Missing required answers fail the semantic stage. Preserve returned model identity and token usage when the selected transport exposes them; mark missing measurements unknown, not zero. Do not invent confidence from a maximum probability or substitute `0.5` for missing evidence.

Use an explicit immutable model identifier if the selected route supports one. If it exposes only an alias, record the alias and returned model, disclose that it is not pinned, and require regression evaluation when it changes. Do not claim deterministic repeated JEV answers.

### Atomic decisions

1. **Intent and required evidence:** classify an ambiguous natural-language request into supported read intentions and required evidence categories. Exact paths/URLs bypass this decision. The model cannot invent endpoints or executable steps.
2. **Independent relevance:** ask whether each candidate directly helps the named task. Do not treat probabilities from separate exclusive Choice batches as comparable relevance scores across files.
3. **Counter-evidence:** separately ask whether a candidate shows intentional compatibility, retained consumers, a failure condition, or a constraint contradicting a proposed simplification.
4. **Representation need:** decide whether an off-path dependency needs a signature or a complete body. Changed code, error paths, authentication decisions and persistence boundaries retain their full relevant logic.
5. **Missing evidence:** identify the most useful missing category from a closed set, such as caller, configuration, test, documentation, provider contract or current check.
6. **Stop/expand:** select a concrete next candidate from the already authorized graph only when it is likely to fill that gap within the remaining budget.

Question IDs are transport keys, not instructions. Include the actual candidate identity and question in the instruction/state the model receives. Never let a repository file supply the system instructions or expand authorization.

Use speculative fan-out for the decisions that affect this packet, not every imaginable question about the repo. Extra questions consume input/output and need measurement even when server latency is similar. A normal context request starts with at most three sequential JEV stages; allow at most one evidence-expansion round. Explicit source/statistics/check requests do not spend JEV calls unnecessarily. These are initial workload budgets, to be validated rather than advertised as achieved performance.

### Calibration and abstention

Select thresholds on held-out Forge tasks, separately for intent, relevance and sufficiency. Measure reliability/Brier-style error for probabilistic judgments and risk-versus-coverage for abstention. Keep calibration fixtures separate from evaluation fixtures. A provider's confidence is not a measured probability that Forge's final packet is correct.

Do not multiply related relevance/support scores as if they were independent. Do not turn a class probability into a reachability fact. Reasking the same model is not independent verification.

When the model lacks confidence, keep the missing evidence explicit. The controller may make the one permitted same-source expansion; otherwise stop as insufficient. No second model, guessed answer or replacement search engine.

## 7. Advanced methods selected for the context compiler

### Structure-aware, request-local graph retrieval

Borrow Aider's useful idea: task-personalized relevance benefits from structure, not just filenames. Build a bounded graph of source files, declarations, imports, documented links, test evidence and changed hunks. Keep syntax edges distinct from compiler-resolved edges. Use anchored neighboring nodes to find the relevant caller, test and configuration without inspecting the entire world. [R4]

The graph is disposable. This is not a hosted GraphRAG database or an embedding index. A one-hop/two-hop witness with source ranges is more useful than an unlabeled diagram claiming complete dataflow.

### Dependency-preserving extractive compression

Borrow Repomix's outline/body distinction and LLMLingua-2's insight that selection can be learned rather than generating a free-form summary. For Forge, select complete source blocks with JEV and preserve their literal bytes; do not deploy LLMLingua weights or delete arbitrary code tokens. [R5, R6]

For a build-error investigation, keep the whole relevant `try/finally`, not only the function signature. Keep negation, guards, cleanup, parameter defaults and the constants needed to interpret behavior. For an API overview, a signature may be sufficient. Lossy selection is always labeled and addressable back to the original source.

### Coverage- and diversity-aware packing

Choose the evidence set using a deterministic marginal-utility-per-token objective: relevant new evidence plus unmet-category coverage, minus duplication, within the output budget. Require instructions, the target implementation and material contradictory evidence before spending remaining space on repeated examples. Deduplicate overlapping spans by SHA/path/range; do not remove a distinct failure test because its boilerplate resembles another test.

This is a constrained selection algorithm, not another AI service. Keep JEV probabilities and structural features as separate inputs. Learn/adjust ranking weights in offline evaluation rather than adding another inference engine.

### Bounded sufficiency-directed retrieval

Adapt the retrieve/check/stop principle from Self-RAG, not its trained model or generation loop. Record the evidence categories needed for the task, identify gaps, expand only the relevant already authorized GitHub neighborhood, and stop at the fixed budget. A JEV sufficiency opinion cannot overrule missing parser coverage, a stale CI artifact or a failed source read. [R7]

### Change-aware evidence reuse

Within a request, deduplicate unchanged blob contents. Across requests, accept an explicit earlier commit and compute what actually changed through GitHub, rather than trusting hidden chat memory. Re-read changed consumers and relevant tests; do not recite unchanged whole files. Source maps and selected spans remain tied to immutable revisions.

Do not add embedding models, generative summaries, multi-agent reviewers, self-training on private source or reinforcement-learning infrastructure to the first implementation. Cutting-edge methodology must improve the measured task, not increase the number of models.

## 8. Context packet and token contract

A packet contains the goal, source identity, relevant binding instructions, exact evidence blocks, relationship witnesses, matching tests/checks, contradictions and unresolved gaps. It is evidence for ChatGPT, not a prewritten conclusion that an edit is correct.

Illustrative output, not a claim about the current implementation:

```text
Source: owner/repo @ <commit>
Goal: understand invoice request failure recovery
Coverage: bounded; selected implementation and tests; provider receipt unverified

Flow evidence:
  invoice form -> contact route -> durable outbox
  Each edge has a source range; unresolved dynamic edges are named.

Source:
  selected complete functions and relevant error branches
Tests:
  relevant test names/bodies and exact-commit check states
Constraints:
  do not resend an uncertain delivery; do not expose the cart key
Missing:
  no inbox-receipt evidence for this commit
```

Initial semantic packet target: about 4,000 tokens, with a bounded larger response for an explicitly broad task. Enforce actual UTF-8 output bytes and record which tokenizer estimate was used; Forge cannot know the host model's true tokenizer from the current contract. Never call character count an exact token measurement.

Measure the whole workflow: returned source, tool schemas, repeated envelopes, tool-call arguments, readback, repair calls and any host-visible duplicate encoding. A small response that forces ten more reads is not an efficiency gain. Output budgets must reserve space for identity, limitations and a usable continuation; never truncate a source block midway and omit the warning.

## 9. GitHub checks and private analysis evidence

Add Checks read, Commit statuses read and Actions read to the GitHub App only through the normal permission approval process. Read checks and statuses as complementary GitHub evidence, not a cascade. Start with names, conclusion, tested commit, workflow/app identity and a small set of file/line annotations; do not dump logs. GitHub exposes these APIs without Forge executing anything. [R8, R9]

Match evidence to the exact requested revision and relevant workflow run/attempt. Handle PR merge-ref checks explicitly: record tested merge SHA and its base/head provenance. A check on a synthetic merge is not automatically a check on the head, and vice versa. Preserve pending, cancelled, timed-out, skipped, neutral, missing and unavailable states. Do not interpret every nonfailure conclusion as sufficient approval.

A repository can publish **one small, schema-versioned analysis artifact** from its existing CI. It may contain unused-code reports, dependency edges, diagnostics, test identities and affected-source references. Require source SHA, producing workflow/tool version, configuration hash, coverage and run attempt. Validate archive size, filenames and schema; artifacts are untrusted data, not executable instructions. Never use an expired/older artifact as current evidence. Repository source analysis is a separate capability, not a substitute result for a missing artifact.

For HeadteacherChat, reuse its existing TypeScript, Knip, lint and test owners. Do not install an overlapping analyzer just because it is fashionable. Add dependency-cruiser or ast-grep only for a specific missing graph/rule capability, with deletion of any equivalent custom analysis. Read their results; do not reproduce their engines in Forge.

No automatic CI dispatch, workflow rerun, or paid CodeQL/private-code-scanning requirement. GitHub Actions can consume allowance or incur charges; this plan does not claim unlimited free compute. Source/context operations remain useful without implying that unavailable execution evidence passed.

## 10. Public references applied to private source

Use GitHub as the only repository/document discovery provider. A bare product/project name routes to repository search. A request for code occurrences routes to GitHub code search. Choose from intent, not the presence of the magic word `repositories`. Pin selected public source before presenting it as evidence. An indexed search result is discovery, not proof of current contents or absence.

Join public references to private use sites inside Forge. The allowed external discovery terms are explicitly named public projects or verified public dependencies/APIs. Do not send private file paths, custom identifiers, error logs, private package scopes or snippets into global search. The discovery permission must not be decided by JEV.

A small reviewed source mapping may associate a public dependency with its GitHub repository and versioned docs/tests. Resolve monorepo packages and release mappings explicitly. Do not infer that an npm package exactly matches a same-named Git tag; when registry artifacts are outside this selected boundary, report repository-version evidence only. Do not manufacture a package-to-tag association.

Reference evidence can include upstream tests, type declarations, documentation, release notes, issues and PRs. Distinguish the installed version, a later fix and unreleased source. The goal is: “this public API contract is relevant to these private locations,” not “other code uses this, therefore our code is safe.” Record attribution/licensing before copying source.

The only model egress is the selected JEV route. Relevant private snippets already sent for JEV decisions remain external processing and must be disclosed; minimize/redact them and apply an explicit deployment policy. Do not repeat the earlier inaccurate implication that private source never leaves Forge while hosted JEV evaluates it. No secrets/customer messages in inference or telemetry.

New metrics use existing Cloudflare observations and CI artifacts, not another analytics service. Do not expand the optional PostHog integration. Reconcile its removal with the existing analytics owner if the no-extra-services policy is applied to all Forge telemetry, rather than silently changing unrelated live reporting.

## 11. Better editing without custom chat scripts

Start with exact span replacement and structured JSONC-record edits, not repository-wide rename.

An edit target carries the expected source/blob identity and a verified current range or node identity. Forge resolves it against the current authorized head, validates every changed file before the GitHub write, and commits atomically within the existing ten-file boundary. Never use stale line numbers from an earlier read. Ambiguous/unsupported selections are refused with evidence.

Check strict format syntax using the correct parser before creating the commit. Preserve comments/format where supported. Block deterministically known introduced syntax errors and genuine conflict markers; do not block on a regex match inside an embedded fixture or a speculative missing-import warning. Only a complete supported resolver can promote missing imports to a structural blocker.

Keep exact fragment edits for small changes. Symbol-body replacement should save transmitting a large old body twice, but requires exact-span tests and expected-state checks. Broad rename/move requires complete type-resolved references and remains outside the first release. Do not split one transformation silently across multiple commits merely to fit the write cap.

Merge preparation re-evaluates proven structural blockers and current required evidence, while preserving SHA-fenced human approval. JEV remains advisory and cannot approve a merge or bypass GitHub policy. If validation was not possible, say so; no green safety label.

## 12. Implementation sequence and removal ledger

Each stage is a focused reviewable change. Deploy each accepted replacement with one active code path; Git history is rollback, not a permanently compiled legacy implementation. A feature is not complete until its replacement tests pass and the superseded path is deleted.

| Stage | Deliverable | Remove | Completion gate |
| --- | --- | --- | --- |
| 0 | Baseline replay tasks, budgets and typed evidence contract | Ambiguous signature/quality wording | No new capability claims; current failures reproduced |
| 1 | SHA-consistent reads, GitHub URL addressing, authoritative selectors and single-path scoped search | Moving-ref reads within one operation; private-to-public widening; index-to-archive cascade; duplicate payloads | Concurrent-head, no-match, oversized and private-scope tests |
| 2 | One JEV wire contract with model/usage evidence and typed failure | Provider sniffing, alternative endpoint, guessed probabilities, swallowed semantic failure | Sanitized real contract fixture plus missing/malformed/timeout tests |
| 3 | Source outlines, exact bodies, Markdown/JSON record selection and bounded graph | Fixed-window semantic slicing for supported formats | Worker-native parser/bundle/span tests, including Astro/Liquid |
| 4 | JEV evidence selection, counter-evidence, one-round gap closure and budgeted packet packing | Agent-side gathering loop and redundant semantic passes | Held-out context recall, task quality, cost and latency gates |
| 5 | Exact-commit checks/annotations and one analysis-artifact reader | Manual log copying and inferred test status | App-permission failure, rerun, merge-ref, stale-artifact and malicious-archive tests |
| 6 | GitHub-only public source resolver and private/public evidence join | Manual upstream source hunting and provider-federation proposal | No private search leakage; version/attribution tests |
| 7 | Span/record edits and structural merge preflight | Large repeated replacement payloads and known-bad-next-action guidance | Atomicity, conflict, no-op, format and cached-client tests |

Stage 5 can be developed after the evidence contract without waiting for stage 4, but its activation still requires the relevant GitHub permissions. Permission approval is not a reason to substitute guessed check state.

## 13. Evaluation: prove efficiency, not just compression

Create at least 30 curated tasks plus generated fault variants. Fixtures must be source-pinned and retain the evidence needed to score them. Use Forge itself, representative HeadteacherChat tasks, and a different-language fixture to expose unsupported coverage honestly. Private production fixtures stay in authorized private storage; sanitize examples before including them in the public Forge repository.

Required tasks include invoice failure recovery, the build `finally` bug, a lease takeover, a retired runner still referenced by tests, an issue-ledger record lookup, a public-project-name search, a source-vs-package-version mismatch, and a failing exact-commit CI check.

Adversarial cases include duplicate symbol names, import aliases, dynamic references, Unicode/CRLF offsets, generated code, code inside Markdown fences, huge archives, embedded conflict-marker fixtures, JEV answer omissions, repository prompt injection, ambiguous URLs, concurrent writes, stale PR artifacts and a reused private package name in a public repository.

Run ablations offline: current Forge; structure only; structure plus JEV; then gap closure and packing. These are benchmark variants, not runtime fallbacks. Grade factual support, required-evidence recall, contradictions retained, fabricated edges, wrong-revision evidence, wrong edits, and the downstream task outcome. Human/code-checked labels are the authority; JEV does not certify its own benchmark.

Initial targets below are acceptance goals, not measurements:

| Metric | Target |
| --- | --- |
| Median model-visible context across a task | At least 50% below the current equivalent workflow |
| Median search/read rounds for the curated tasks | At least 50% fewer |
| Critical required-evidence retention | No regression on curated safety/failure-path fixtures |
| Wrong-source and unsupported-safety claims | Zero in the acceptance fixture set |
| Typical semantic packet | Approximately 4,000 tokens with honest tokenizer/coverage metadata |
| Sequential JEV stages | At most 3 normally; at most one bounded expansion |
| Full-file/source/CI operations | No unnecessary JEV call |
| Runtime resilience | Explicit outcome for every injected upstream/parse/schema failure; no substitute provider/result |
| Runtime memory, bundle size and latency | Within deployed Worker limits under tested concurrency, with measured headroom |

Measure total JEV input/output usage and request cost, GitHub calls, bytes downloaded/retained, parser CPU, response bytes and end-to-end latency. Do not assert a 50–70% saving because another project reported it. Do not move cost from ChatGPT into repeated JEV requests or whole-archive downloads and call that success. Do not upload source, queries, repo names or private identifiers to analytics.

## 14. Acceptance and release

- [ ] Current behavior is reproduced on the named baseline; targets are measured rather than assumed.
- [ ] Exactly five tools remain; first-party operation discovery does not depend on magic query words or custom ChatGPT orchestration code.
- [ ] One authoritative implementation serves each operation; all replaced cascades and silent substitutions are removed.
- [ ] One JEV transport is validated; semantic failure cannot look like semantic success.
- [ ] Context references immutable source; every graph edge and diagnostic has an appropriate evidence type.
- [ ] Explicit paths, proposal source, symbols, document sections and ledger records are selectable without unnecessary rereading.
- [ ] Unsupported languages, incomplete scopes, missing permissions and stale tests remain visible.
- [ ] No additional hosted indexing, docs, security, AI or telemetry service is required.
- [ ] No repository code/plugin/config executes inside Forge; private data boundaries pass adversarial tests.
- [ ] Exact source/test coverage is retained while the token/call targets are met on held-out tasks.
- [ ] `pnpm check` and Worker-native integration tests pass for the final source SHA.
- [ ] MCP version, schema, annotations, examples and connection-refresh instructions agree; old incompatible inputs fail explicitly rather than silently taking another path.
- [ ] Authorized deployment smoke and a fresh phone/ChatGPT conversation prove read, context, edit, review and human approval. Documentation alone is not release evidence.

This planning commit does not implement the engine, change GitHub App permissions, invoke new services, dispatch CI, run production failure injection or authorize deployment.

## 15. Research basis

Primary references checked on 20 September 2026. They support the methods/capabilities below, not measured Forge results. Upstream branch URLs are research links, not runtime proof of a pinned dependency version.

- R1: [TypeSafe introduction](https://docs.typesafe.ai/introduction) and [API](https://docs.typesafe.ai/api): typed decisions, independent questions, Choice/Score/Noul contracts, model/usage fields and limits.
- R2: [TypeSafe patterns](https://docs.typesafe.ai/patterns): atomic composition, speculative fan-out and intent routing. This plan rejects the alternative-provider/fallback aspect of any example.
- R3: [TypeSafe confidence](https://docs.typesafe.ai/confidence): probability versus confidence and domain-specific thresholds. Treat calibration as something to evaluate on Forge's tasks.
- R4: [Aider repository-map design](https://github.com/Aider-AI/aider/blob/main/aider/website/_posts/2023-10-22-repomap.md): structure and query-personalized graph ranking. Adopt the method, not its local cache/workspace architecture.
- R5: [Repomix compression](https://github.com/yamadashy/repomix/blob/main/website/client/src/en/guide/code-compress.md): outlines/signatures versus implementation bodies. Do not inherit advertised token-reduction percentages.
- R6: [LLMLingua-2](https://arxiv.org/abs/2403.12968): extractive, classification-based context reduction. Block selection in Forge is an adaptation, not an implementation or validation of this model.
- R7: [Self-RAG](https://arxiv.org/abs/2310.11511): selective retrieval and evidence critique. Adapt the control idea without adding a trained generative model or unbounded loop.
- R8: [GitHub check runs](https://docs.github.com/en/rest/checks/runs) and [commit statuses](https://docs.github.com/en/rest/commits/statuses): execution evidence keyed to GitHub revisions.
- R9: [GitHub Actions artifacts](https://docs.github.com/en/rest/actions/artifacts): authenticated access to repository-produced evidence, not execution inside Forge.
- R10: [Cloudflare Wasm](https://developers.cloudflare.com/workers/runtime-apis/webassembly/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): precompiled modules, runtime limits and bundle/startup constraints. Wasm availability alone does not establish parser compatibility.
- R11: [Astro compiler](https://github.com/withastro/compiler/blob/main/README.md): AST support and the explicit warning about source positions.
- R12: [Anthropic: code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp): keep intermediate data processing out of the model context. Forge adopts that data-handling principle through first-class fixed operations, not generated code execution.

### Final design rule

**GitHub establishes source truth. Parsers establish supported structure. JEV selects useful evidence and exposes uncertainty. Forge assembles it. ChatGPT reasons. GitHub CI supplies execution evidence. A human approves consequential changes.**
