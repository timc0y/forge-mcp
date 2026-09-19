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
