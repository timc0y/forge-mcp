# Forge branch incident autopsy — work reported as "on the branch" that was never on GitHub

**Date:** 2026-07-27
**Status:** root-caused, fixes landed

## Incident

A diagnosis document was written and committed inside a temporary Forge
workspace and then described as being "on the Forge branch". It was never
pushed. The branch existed only inside the workspace, and the workspace was
later reaped.

- Document: `docs/reviews/2026-07-27-whole-system-diagnosis.md` (lost)
- Workspace branch: `forge/25b5950a6fd54c95`
- Local commit: `2ce892595853a245ab0810af77dad6ee0f72a7d0`
- On GitHub: nothing — no branch, no commit, no pull request

## What happened

1. Forge cut a temporary workspace branch from `main`.
2. The file was written with Forge's file tool.
3. Forge auto-committed it on that branch.
4. **The write call returned an error even though the workspace head had
   advanced.**
5. The observer then reported a new head commit, one outgoing changed file, and
   `hasUnpushedWork: true`.
6. No push happened.
7. The workspace entered a failed state and was reaped.

## The incorrect inference

Three facts were treated as proof of durable storage:

- Forge displayed a branch name.
- Forge displayed a commit SHA.
- Forge showed the file in an outgoing diff.

All three are equally true of work that exists only inside a temporary
workspace. The missing distinction:

> A local Git branch with a commit is not the same thing as a branch pushed to
> GitHub.

`hasUnpushedWork: true` was visible the whole time and should have stopped the
claim on its own.

## Root cause

Primary: no verification of remote persistence before reporting branch
availability.

Contributing, and the part that was Forge's fault rather than the agent's:

- The write call **errored after successfully committing**, so a partial
  success was reported as a total failure.
- The opaque workspace branch name looked like an ordinary branch reference.
- There was no explicit final "push or submit" step.
- An outgoing diff was treated as a saved deliverable.

## Fixes landed

### 1. A push failure no longer erases a successful write

`WorkspaceCoordinator.tryAutoPushAfterCommit` threw `FORGE_GIT_PUSH_BLOCKED`
when the post-commit auto-push failed. The write and the commit had both
succeeded, so the agent was told "your write failed" — which is false, and is
why it retried the *write* instead of the *push*.

The push outcome is now data, not an exception
(`WorkspaceCoordinator.reconcileDurability`).

### 2. A failed push no longer strands the commit forever

The old code only attempted a push when *that call* produced a commit. A retry
whose commit was a no-op skipped the push entirely, so the first failed push
stranded that commit permanently — nothing in the edit path would ever try
again.

Durability reconciliation now keys off `hasUnpushedWork`, so every subsequent
mutation re-attempts the push until origin actually has the work.

### 3. "Nothing to commit" is no longer a hard failure

An agent retrying a write after a push error re-runs the same edit, so there is
genuinely nothing new to commit. `gitCommit` reported that as
`FORGE_GIT_DIRTY: Forge could not create the commit`, inventing a second,
misleading fault while the real problem went unmentioned. It now returns
`{ committed: false, reason: 'nothing to commit' }`. Genuine commit failures
still throw.

### 4. Every mutating tool reports one explicit durability state

`apps/forge-edge-gateway/src/durability.ts` is the single place that decides
where work lives. Every file tool and `forge_git_commit` now return:

| field | meaning |
| --- | --- |
| `durability` | `local_only` \| `remote_branch` \| `pull_request` \| `failed_recovered` |
| `on_remote` | true only when a commit is verified present on origin |
| `durability_statement` | a sentence safe to repeat verbatim |
| `remote_branch`, `remote_sha` | present only when actually on origin |

`local_only` states plainly that the work is **not** on GitHub and will be lost
with the workspace.

### 5. The remote SHA is recorded from every path, not just `forge_git_commit`

Only `forge_git_commit` recorded `remoteBranchSha`. Every file tool auto-commits
and auto-pushes through a different path, so an agent that did the whole job
with `forge_files_write*` — the documented way to edit — genuinely landed its
work on origin but left `remoteBranchSha` unset. Task completion then refused
with "the feature branch is not verified on origin", about a branch that *was*
on origin. That false blocker was its own source of flailing and it hid the
real one.

Remote verification itself was already correct: `autoPushForgeBranch` confirms
the push with `git ls-remote` and compares against HEAD before claiming success.

## Operating rule

Before saying work is "on a branch", all of the following must be true:

1. The branch exists on the remote repository.
2. The expected commit is reachable from that remote branch.
3. The expected files can be fetched from that remote branch.
4. If a pull request was requested, it exists and points at that branch.

Workspace state alone is not sufficient. A branch name, a commit SHA and an
outgoing diff are not evidence of durability.

## Required closing language

Every piece of Forge work ends in exactly one of these states, and it should be
named:

- **Local only** — committed in the workspace, not pushed.
- **Remote branch** — pushed and verified on GitHub.
- **Pull request** — pushed, PR created and verified.
- **Failed / recovered** — workspace failed; content supplied as an artifact.
