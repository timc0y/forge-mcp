# Repository intelligence without a runner

Research and implementation note, 2026-09-19.

## Goal

Make Forge better at understanding and safely changing repositories without
reintroducing the executor, checkout, workspace, background job, or second copy
of repository state that the current architecture deliberately removed.

The useful boundary is **GitHub state that already exists**: trees, committed
files, diffs, GitHub search, and repository-native automation that reacts to a
commit. Forge can inspect and summarize those things. It should not become the
place code executes.

## Patterns worth borrowing

### Biome — changed state is a Git concept

Biome's CLI has explicit changed/staged-file selection. The useful idea for
Forge is not the local runner; it is that analysis should be scoped to a Git
boundary rather than an ambient mutable workspace. Forge already has an even
stronger boundary: the commit SHA GitHub just accepted.

### jscodeshift — discover, count, then transform

jscodeshift separates dry runs/statistics from mutation and reports transformed,
unchanged, skipped, and errored files. For Forge, `forge_read query:"find:<text>"`
is the discovery step and ordinary fragment replacements remain the mutation
step. A wide replacement should stay visible as several small durable commits
rather than becoming an opaque repository-wide mutation engine.

### ast-grep — structural search beats blind text replacement

ast-grep's strong idea is syntax-aware matching and replacement. Reproducing its
parser/runtime inside Forge would violate the current boundary. The near-term
substitute is scoped GitHub code search plus semantic ranking. If structural
rewrite becomes a repeated need, integrate an external committed-code service or
repository Action rather than embedding a new executor.

### Tokei / scc — summaries make large repositories legible

File counts, byte totals, largest files, directory concentration, and extension
breakdowns are cheap and often answer the first architectural question. GitHub's
recursive tree already carries blob sizes, so Forge can expose these statistics
without downloading source files or storing an index.

### Semgrep — useful analysis, wrong execution boundary for Forge

Semgrep demonstrates the value of deterministic static checks and semantic
security rules, but its agent hooks execute scanners locally. Forge should not
copy that mechanism. Small checks derivable from the committed tree are fine;
full lint/test/security suites belong in repository CI.

## Implementation boundary

The deterministic pieces now live in `worker/src/repository-intelligence.ts` rather than growing `tools.ts` or the Jev client. `tools.ts` orchestrates GitHub calls and tool envelopes; `jev.ts` contains Jev-backed decisions; repository intelligence owns pure tree/diff/text analysis. The split is deliberate dogfooding of the file-size signal this work introduced.

## Implemented in this change

### `forge_read` repository statistics

`query: "stats"` now returns:

- tracked file count and byte total;
- largest top-level folders by bytes;
- largest file extensions by bytes;
- largest individual files.

This is computed from the GitHub tree already used by Forge. No new API
permission, service, dependency, index, or tool is introduced.

### Scoped statistics and repository map

`query: "stats"` summarizes the whole tracked tree, while `query: "stats <path>"`
uses the same GitHub tree metadata for one committed folder. `query: "map"`
classifies tracked files into source, tests, docs, automation, data/schema,
assets, config, and other, then points out likely entry files. This is a path
map, not a claimed call graph.

That distinction follows the useful boundary seen in ast-grep's outline model:
a compact structural outline is valuable without pretending it proves every
reference edge. Sourcegraph SCIP demonstrates the other side of the line: true
find-references/go-to-definition semantics need language indexers and an index.
Forge should not recreate that infrastructure implicitly.

### Hunk-level semantic diff targeting

File ranking is not enough when one changed file contains several unrelated hunks. For an ordinary semantic question about a proposed change, Forge now enriches the strongest candidate files with GitHub patch text, deterministically splits unified patches into hunks, keeps query-bearing hunks plus an even representative sample when there are too many, and uses Jev to rank the most relevant hunks. The returned patch snippets for that semantic question are those targeted hunks rather than automatically dumping the entire patch.

Explicitly requested paths still return their full GitHub patch. Semantic-hunk results disclose that they are excerpts and tell the caller to request the path for the complete diff. This is another place Jev adds value without becoming a code parser: choosing *where to look* inside evidence GitHub already supplied.

### Search-based impact candidates without a fake reference graph

API Extractor, GraphQL Inspector, dependency-cruiser, Madge and SCIP all demonstrate that trustworthy API/reference/dependency graphs require real parsers or language tooling. Forge should not pretend text search is equivalent. It can still answer a narrower useful question: “what else might mention a contract or identifier this change removes?”

`query: "impact"` on a change now takes patches for at most 20 changed files, deterministically extracts identifier-like terms from removed lines, removes common language noise, and lets one Jev Choice rank which candidates look most externally meaningful relative to the human change intent. Forge searches the top three exact terms on the base branch and shows matching paths outside the proposed change. Every result is labelled `IMPACT?` and explicitly described as text-search evidence, not compiler-backed references or proof that anything breaks.

This gives Forge a useful impact lens while keeping API Extractor/GraphQL Inspector/dependency-cruiser/Madge in the category they belong: real repository CI or developer tooling.

### Semantic triage for exact codemod matches

Facebook's original codemod separates counting/discovery from mutation and treats an automatic accept-all mode as something to use cautiously. Forge keeps that shape but can make the discovery evidence richer without adding an AST runtime. For complete matching files within the read budget, `find:<text>` now extracts up to 20 exact local occurrence contexts with line numbers. One Jev fan-out independently classifies each bounded occurrence as declaration/definition, code reference/call, import/export, configuration/serialized contract, test/fixture/example, documentation/prose, generated/vendor, or unknown.

Those labels are explicitly **not** compiler-backed references. They are semantic triage over exact textual matches, intended to distinguish an identifier rename from prose or serialized-contract occurrences before the user/model chooses bounded `forge_edit` replacements. The mutation primitive remains unchanged and `all:true` still means every exact textual match in that one file.

### Scoped exact and semantic committed-code search

`query: "find:<text>"` searches GitHub code inside the named repository and
returns matching paths plus snippets. For matching files small enough to read
completely, Forge also counts exact occurrences. `query: "code:<concept>"`
uses Forge's GitHub query synthesis and Jev ranking against committed-code
results, which is useful when filenames do not describe the implementation.
Normal queries continue to use the cheaper semantic path/file ranking first. If both semantic path triage and literal filename matching produce no candidate, Forge now falls through to a bounded committed-code search automatically; `code:` remains the explicit route when content semantics are wanted immediately.

This gives a safe workflow for "find every X and replace it with Y":

1. read with `find:X`;
2. inspect the matching committed paths/snippets;
3. use existing `forge_edit` fragment replacements on those paths;
4. split more than ten files into several durable commits, preserving the
   existing chat/write budget.

Forge intentionally does not add a top-level "replace the entire repository"
mutation. Discovery and mutation remain separate, observable acts.

### Release conventions and contract-file evidence

Changesets and semantic-release reinforce a useful split between *consumer impact* and the mechanical act of publishing. Forge can detect a repository convention and ask whether it is relevant without becoming the release engine. When a Jev change assessment strongly indicates user-visible/breaking/documentation-relevant impact, the review packet checks whether `.changeset/config.json` exists. If the repository uses Changesets but the proposed diff includes no `.changeset/*.md`, Forge emits an advisory release-metadata notice rather than inventing a required version bump.

Similarly, contract-like changed paths such as OpenAPI/Swagger/AsyncAPI schemas, `.proto`, GraphQL schema files and API Extractor `*.api.md` reports are called out deterministically. Forge does **not** attempt GraphQL Inspector/API Extractor-style compatibility analysis; those require real schema/compiler semantics and belong in repository quality gates.

The packet now runs its GitHub policy/review/dependency reads and the bounded Jev assessment concurrently, then performs the optional Changesets convention lookup only when the semantic assessment says release metadata is plausibly relevant.

### Actionable companion-file suggestions

The decomposed Jev review signals are now used to find evidence, not merely produce warnings. If Jev is highly confident that tests matter and no obvious test path changed, the shared review packet reads the base tree, filters to real test-like paths, and reuses high-cardinality semantic path triage to suggest up to three likely `TEST?` companion files. The same happens for documentation when documentation relevance is very high and no documentation-like path changed.

These pointers are deliberately labelled candidates. Forge does not say a suggested test covers the change, that the file must be edited, or that a missing suggestion means coverage is absent. A truncated GitHub tree is disclosed. This is the preferred Jev pattern for Forge: **turn an uncertain predicate into a bounded path to evidence**, rather than converting it into a verdict.

### Read-only change review packets

The same evidence used to prepare a merge approval is now available through `forge_read` with a change and `query: "review"`. This route is read-only: it combines GitHub branch rules, required approval/check names, latest review states, one-shot mergeability, dependency-diff findings and one bounded patch-rich Jev assessment before Forge creates any approval record. The packet builder lives in `change-review.ts` so merge preparation can reuse exactly the same evidence rather than developing a second definition of what matters.

### Change-aware stats and diff semantics

The same `stats [path]` query now has a useful meaning when reading an open
Forge change: it sorts changed files by line churn, can scope that view to a
folder, and reports the highest-churn top-level areas from GitHub's comparison.
This is a change-size signal, not a quality or risk score.

Semantic change queries also now use patch content where practical. Previously
`rankChangeFilesWithJev` was usually handed changed paths with no patches, even
though its interface accepted patch snippets. Forge now does a bounded second
comparison for up to 20 candidate paths and re-ranks those candidates with their
actual diff snippets. Large changes first narrow by path semantics, then enrich
the bounded candidates. Explicitly requested paths remain first so semantic
ranking cannot hide a file the caller asked to inspect.

### Resolved-content safety for fragment edits

Researching repository-wide replacement flows exposed an existing safety gap in the write path. `checkCommitSafety` used to run against the raw `forge_edit` payload before fragment replacements were resolved. A fragment edit has `replace` instructions but no whole-file `content`, so secret/truncation checks could inspect nothing for that file. The safety gate now runs after Forge resolves replacements against the exact GitHub head but before it creates blobs or a commit. Whole-file and fragment edits therefore pass through the same final-content safety boundary.

### Post-commit advisory lint

Forge already contained a dangling-relative-import check, but it was gated on
Jev and called without repository paths, so it could not do useful work. It now
runs only **after** GitHub has accepted a real commit. The deterministic advisory
currently checks relative imports, source merge-conflict markers, and JSON
syntax:

1. read the committed tree at the returned SHA;
2. read the final committed versions of changed text files;
3. check relative imports against that committed tree;
4. attach any warning to the receipt as a non-fatal post-commit notice;
5. disclose changed files it could not inspect because of tree/read budgets instead of implying complete coverage.

If this analysis fails, the commit remains a successful commit. Forge never
turns durable work into an error because an advisory check failed.

## Committed-work compiler linting

Forge's worker TypeScript configuration now enables `noUnusedLocals` and `noUnusedParameters`. The existing GitHub CI already runs `pnpm typecheck` only after a push/PR exists, so this catches stale imports, dead locals and forgotten parameters on committed work without adding ESLint/Biome, a pre-commit hook, or any execution capability to Forge itself. Parameters intentionally unused can still follow TypeScript's underscore convention.

This is exactly the sort of linting Forge should prefer: use the compiler for a concrete defect class before adding a general-purpose lint dependency.

## Tests and linting

Forge's own repository already runs TypeScript checking and Vitest on GitHub
`pull_request` events and on pushes to `main`. That is already the desired
"committed work only" model: the repository reacts to GitHub state; Forge does
not execute pre-commit code.

Do not add a general-purpose linter dependency merely to have a linter. Prefer,
in order:

1. stricter TypeScript compiler guarantees when they cover the defect class;
2. a focused invariant test for a Forge-specific failure mode;
3. an existing repository-native linter/action when a real class of defects
   remains uncovered.

## GitHub-native dependency and policy intelligence

Two current GitHub APIs fit Forge unusually well because both answer synchronous questions about durable GitHub state using permissions Forge already has.

**Dependency review.** GitHub's `dependency-graph/compare/{base...head}` endpoint needs only Contents read. Forge can now use `query: "dependencies"` on an open change to show added/removed dependencies, scope/license metadata, and vulnerability advisories GitHub associates with the changed dependency graph. A private repository may legitimately return 403 when GitHub Code Security is unavailable, and Forge reports that limitation rather than substituting its own package scan. Merge preparation also adds a warning when GitHub reports vulnerability findings in the dependency changes. When an ordinary `forge_edit` commits a dependency manifest/lockfile, Forge additionally reads the durable commit's parent and runs the same GitHub dependency diff *after* durability, attaching added/removed counts and vulnerability findings to that commit receipt without running a package manager.

This is deliberately based on the commit-to-commit dependency diff, not GitHub's full SBOM export. GitHub has announced the synchronous SBOM export endpoint will close on 13 November 2026 in favor of an asynchronous generate/fetch flow; adopting that would pull Forge back toward polling/state for a feature it does not need.

**Branch policy.** GitHub's active-rules-for-branch endpoint needs only Metadata read. `query: "policy"` now shows the active rules applying to the default branch and extracts required status-check context names where GitHub supplies them. Merge preparation can therefore say what checks GitHub requires without pretending Forge knows whether those checks are currently green. Reading actual check/status results still needs additional permission and remains a separate decision.

## Candidate: surface repository CI results

The attractive next step is **read-only visibility into checks on the commit
Forge just created**. That would let a later `forge_read` say that repository
CI passed or failed without Forge running anything.

Do not implement this casually. The current GitHub App requires Contents,
Pull requests, and Metadata permissions only. Reading modern Check Runs requires
an additional GitHub App permission, which changes the installation/re-consent
surface. Forge also cannot poll from an ordinary chat, so an edit result must
not promise to wait for checks.

The correct shape, if the permission cost is accepted, is:

- commit immediately and return the durable receipt;
- repository Actions/checks run independently because GitHub saw the commit;
- a later `forge_read` can report current check state for the default/change
  head;
- no background watcher, queue, polling loop, or "wait until green" workflow.

## Review and ownership evidence with existing permissions

Forge's current Pull Requests permission can read review records, and Contents read can read a pull request's one-shot `mergeable` state. Merge preparation now combines those with branch rules: required approval count, code-owner-review requirement, review-thread-resolution requirement, current latest approval/change-request counts, and GitHub's current mergeability result when it has one. GitHub explicitly allows `mergeable` to be null while it computes in the background; Forge reports that as unknown and does not poll.

GitHub also exposes CODEOWNERS syntax errors through a Contents-read endpoint. When a Forge commit changes one of GitHub's recognized CODEOWNERS locations, the post-commit advisory asks GitHub to validate the committed version and attaches any syntax errors/suggestions to the durable receipt. This is stronger than maintaining a second CODEOWNERS parser inside Forge.

## Declared quality-gate interpretation

A repository's committed automation/configuration is evidence about what quality gates it *declares*, even when Forge cannot run them or read their current Action status. `query: "quality"` now selects a bounded set of likely workflow/package/tooling configuration paths from the Git tree. Package scripts with test/lint/type/check/build/security/deploy-like commands are parsed deterministically. One Jev fan-out then independently chooses the most likely owning config file for tests, type checking, lint/format, security, build, deploy, and dependency automation, with an explicit `none` choice and confidence threshold.

The distinction is load-bearing: `SCRIPT` lines are exact committed configuration; `LIKELY GATE` lines are Jev interpretations of configuration naming/content and explicitly do **not** mean the check executed or passed. `policy` remains the authoritative view of which status-check names GitHub actually requires at merge time.

## Bounded churn without a history index

`query: "churn"` samples the eight newest commits from GitHub, reads their changed-file summaries in parallel, and aggregates touch count plus line churn by path. The output is explicitly a bounded recent window, not a timeless maintainability score. If GitHub signals older commits or a commit with more changed files than the sampled detail exposes, Forge marks the sample incomplete. This gets much of the practical “what are our hot files?” value of history-analysis tools without storing an index or cloning the repository.

Branch policy parsing also distinguishes `require_last_push_approval` from ordinary approval count: when configured, the shared review packet states that the latest reviewable push needs independent approval.

## Bounded history, language distribution and current-tree shape

GitHub's commit-list endpoint accepts both a branch and optional path filter under the existing Contents permission, so Forge now supports recent repository or path history without cloning Git. The result is deliberately bounded to the twelve newest matching commits and includes the short SHA, date, author, signature-verification state when GitHub provides it, and first commit-message line. It is a history window, not a permanent churn index.

GitHub's language endpoint uses Metadata read and returns byte counts by detected language. Forge exposes that distribution separately from tree statistics because GitHub Linguist's classified-language bytes and raw tracked-file bytes answer different questions.

Current-tree statistics now also report structural shape borrowed from the useful parts of `git-sizer`: directory count, maximum file path depth, longest tracked path, and the widest directory by direct entries. These are measurements only—Forge does not invent universal thresholds or a repository-health score. Full historical Git object sizing still belongs to a real `git-sizer` run outside Forge.

## More GitHub-state ideas that still fit the boundary

- `history [path]`: GitHub's list-commits endpoint accepts a path filter and requires only Contents read. A bounded history view could answer who/when/why a file last moved without a clone.
- language distribution: GitHub's repository-languages endpoint needs only Metadata read and returns byte counts by language; useful alongside tree stats.
- tree health borrowed from git-sizer: maximum path depth, longest paths, directories with unusually many direct children, and oversized tracked blobs can all be measured from the current Git tree without claiming full Git object/history size.
- quality-gate inventory: inspect committed workflow/config files and package scripts to identify which test/typecheck/lint/security gates a repo declares. That is configuration evidence, distinct from running those gates.
- targeted recent churn: fetch a small bounded set of recent commits and their changed-file lists to identify frequently touched files. Avoid a permanent history index and disclose the sampled window.

## Jev as an evidence router, not a command language

As `forge_read` gained useful evidence modes, explicit strings such as `quality`, `policy`, `churn`, `review`, `impact` and `dependencies` risked becoming a hidden command language. Forge now has a high-confidence Jev router for natural-language questions that contain evidence-domain hints. Repository questions can route to quality gates, GitHub policy, languages, churn, stats, structure or recent history; change questions can route to review, impact, dependency review, policy or change stats.

Routing is deliberately conservative. Ordinary navigation/implementation questions do not call the router at all. Even when hint words are present, a separate Noul predicate must say specialized evidence is the right answer with at least 0.72 probability, and the Choice must clear a confidence threshold. Otherwise the original question continues through ordinary semantic path/code search. Call sites disclose the selected evidence mode and confidence when routing occurs.

## Jev change assessment: independent signals, not a score

TypeSafe's workflow evals repeatedly decompose a policy into independent Noul/Choice/Score questions and combine the probabilities in code. Forge now applies that pattern to merge evidence. A bounded patch-rich state is asked, in one Jev call, about primary technical area, intent alignment, breaking-contract likelihood, security sensitivity, persistent-data changes, user visibility, test relevance, documentation relevance, multiple independent concerns, and a possible scope-outlier file.

Forge deliberately does **not** collapse these into an AI risk score. OpenSSF Scorecard's own documentation makes the relevant point: aggregate scores can obscure which concrete behaviours produced them. Forge instead exposes only high-confidence individual notices, and every notice remains advisory. Examples include a likely schema/data-lifecycle change, a security-sensitive diff, a probable outlier file, or tests looking materially relevant when no obvious test path changed.

Merge preparation fetches bounded GitHub patches first, runs this Jev fan-out once, stores the resulting concise summary in the frozen approval evidence, and reuses it in the tool receipt. This removes the previous duplicate Jev summary call and ensures the decision sees actual diff content instead of paths alone.

## Jev high-cardinality retrieval and context compaction

Aider's repository map demonstrates the value of query-personalized context, but achieves it with Tree-sitter tags, a reference graph, PageRank and caches. Forge should not recreate that index. TypeSafe's own Wikiracing example provides a better fit: Jev has a 255-choice ceiling, and TypeSafe describes using a two-stage scoring/choice system for higher-cardinality decisions.

Forge's path triage now follows that shape. Up to 5,000 representative paths are ranked in parallel batches, each batch contributes a handful of finalists, and a final Jev choice globally reranks those finalists. Enormous repositories use lexical-priority plus even sampling across the whole tree, and the read result discloses when only a representative subset was considered. This replaces the previous first-750-files cap and the incorrect concatenation of independently ranked batches.

Long-file excerpting is similarly query-personalized without an index. Each 40-line window now shows Jev query-bearing lines plus first/middle/last context rather than only its first five lines. Files with more than 40 windows select lexical hits plus an even sample across the full file, so relevant code near the end is no longer excluded by position alone.

## Candidate: richer semantic repository map

Current semantic repository search ranks paths and selectively reads relevant
file excerpts. Improvements that stay inside the boundary include:

- decide whether normal repository-level natural-language queries should
automatically blend code-search candidates with semantic path ranking, or
whether the explicit `code:` mode is the better latency/cost boundary;
- enrich likely routes, schemas, migrations and entry points from small committed
  excerpts without claiming a full call graph;
- summarize a change by subsystem concentration and churn, using its diff;
- answer "where does X enter/leave this system?" from search candidates without
  creating a persistent code index.

Avoid vector databases, scheduled embeddings, repository mirrors, or generated
code maps stored outside GitHub. They create a second truth and a synchronization
problem for a feature whose main architectural achievement is removing both.

## Explicit non-goals

- no checkout or workspace;
- no shell or package-manager execution;
- no generic test runner;
- no background jobs or polling;
- no new MCP tool merely for stats/search;
- no silent repository-wide rewrite;
- no persistent semantic index.

The test for future additions is simple: **can this be answered from durable
GitHub state in one request, and can failure degrade without putting repository
truth in doubt?** If not, it probably belongs outside Forge.
