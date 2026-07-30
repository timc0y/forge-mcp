# Context selection, diff metadata and targeted verification

Status: implemented (initial slice).

## Problem

ChatGPT is the reasoning agent; Forge must make its execution cheap and its
evidence deterministic. Three recurring needs:

1. **Which files matter** for a goal, without reading the whole repository.
2. **What actually changed** in a diff, without a model summarising it.
3. **Which checks to run** for a change, narrow before broad, without Forge
   silently running anything expensive.

## Model

A new pure, dependency-free package `@forge/insight` (no embeddings, no
Vectorize, no model, no sandbox) provides three deterministic capabilities.

### Bounded context selection — `selectContext`

Ranks tracked files against the goal's tokens and the task's likely paths.
Returns path, reason, governing instruction files (AGENTS.md/CLAUDE.md up the
tree), adjacent tests, package context, warnings and a relative confidence —
**never file contents**. Generated files are excluded; category filters
(`source`/`tests`/`docs`/`config`) are honoured; clipping to `max_results` is
reported via `truncated` so nothing is silently dropped. One-hop only: it does
not recursively ingest the repository.

Exposed as `forge_context_get`, which reads the selected GitHub branch tree and
runs the selection without allocating an executor. The client decides what to
read with `forge_files_read`.

### Compact diff metadata — `analyzeDiff`

Parses a raw Git unified diff into changed files (with change type, additions,
deletions), changed exports/functions/classes, changed tests, config changes,
worker-config changes, migrations, lockfile and generated changes, possible
secret exposure, risk areas, suggested hunks and a stable FNV-1a hash. It is
**syntax-only** and claims no semantic certainty.

Exposed as `forge_diff_metadata`, which compares the selected GitHub branch with
its base and returns syntax-only metadata plus the diff hash. The compact summary
never substitutes for reviewing the GitHub comparison before opening a PR.

### Targeted verification — `suggestChecks`

Maps changed paths to suggested commands, narrow to broad, each carrying command,
cwd, reason, cost class, whether network is required and whether it is required
or optional. Rules: package source → package typecheck then package tests;
worker config → `cf:typegen` then `wrangler deploy --dry-run`; migration →
`schemas:check`; build tooling or lockfile → full build; documentation-only →
doc lint only. Nothing executes — the client chooses.

## Tests

`tests/unit/insight.test.ts`: path classification; diff file/line counts, change
types, changed exports, migration detection, stable hashing, secret flagging;
check suggestions for packages (narrow→broad), docs-only, and worker/build
tooling; context ranking, generated-file exclusion, instructions/adjacent-tests/
package context, category filters and truncation reporting.

## Out of scope for this slice

- Import/export graph following beyond filename adjacency for tests.
- Attaching diff metadata automatically onto every GitHub review response.
- Cost instrumentation — separate plan.
