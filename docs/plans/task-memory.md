# Durable task memory

Status: implemented (initial slice).

## Problem

Forge gives compatible AI clients a safe remote development computer. The client
supplies reasoning; Forge supplies repository state, execution, previews, browser
evidence, Git operations and durable task context.

Before this change the only unit of continuity was the disposable **workspace**.
When a ChatGPT conversation was compressed, the MCP session reconnected, or the
container slept, the coding session's context was lost. The reasoning agent had
no cheap, durable place to record its goal, decisions and progress.

## Model

A **task** is a durable coding-session record that lives above the temporary
workspace. It survives MCP reconnects, ChatGPT context compression, container
sleep, browser closure, process failure and client reconnection.

A task references at most one workspace at a time but outlives every workspace it
uses. Terminology follows `docs/product` and the task never becomes a
general-purpose task manager: the public API is deliberately five tools.

### States

`planning → ready → coding ↔ validating ↔ previewing ↔ reviewing ↔
awaiting-approval → complete`, with `failed` and `cancelled` as the other
terminal states. Transitions are validated in `@forge/task-core`
(`assertTaskTransition`); terminal states are absorbing.

### Record

`Task` (see `packages/task-core/src/task.ts`) carries: id, tenant/project,
repository, base ref, goal, decisions, non-goals, likely paths, files read,
branch, workspace id, process ids, preview id, browser session ids, changed
files, checks, evidence ids, latest diff hash, state, outstanding work, an
optimistic `revision` and timestamps.

### Compact summary

`forge_task_summary` (`summarizeTask`) is the most important reconnect
capability. It returns enough for a fresh turn to resume — goal, decisions,
non-goals, base ref, branch, workspace/preview state, files read/changed, checks
and their status, evidence ids, outstanding work, known limitations, the next
recommended action, state and updated timestamp — and deliberately **excludes**
full source, complete logs, complete diffs, secrets and raw environment. Every
string is passed through `redactSecrets`; large evidence stays in R2 and is
referenced by artifact id.

## Persistence

D1 table `tasks` (migration `migrations/d1/0009_tasks.sql`). Promoted columns
carry the queryable fields; resume-relevant context is stored as bounded JSON in
`document`. `D1TaskStore` in `@forge/metadata-d1` mirrors the in-memory
`InMemoryTaskStore` contract used for the local single-owner deployment and
tests. Ownership is checked (`assertTaskOwnership`) before any task is returned,
and mutations use optimistic revisions (`applyTaskPatch`).

## Tools

`forge_task_start`, `forge_task_get`, `forge_task_summary`, `forge_task_list`,
`forge_task_finish`. None create a container; all are cheap. The intended
workflow is: start a task first, attach one workspace only when execution is
needed, keep the task updated as the durable memory, and finish it (which leaves
the record and evidence retrievable).

## Tests

`tests/unit/task.test.ts` covers lifecycle and transitions, terminal states,
additive merges without duplication, optimistic-revision conflicts, tenant
ownership, put/get round-trip after mutation (reconnect/resume), list ordering
and filtering, store isolation, compact-summary content, the reviewing-without-
diff limitation, and secret redaction.

## Out of scope for this slice

- Wiring task ids automatically into every workspace/git/browser tool result.
- Context selection (`forge_context_get`) and compact diff metadata — separate
  plans.
- Cost instrumentation on task responses — separate plan.
