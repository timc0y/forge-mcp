# Failure contracts

These are the current recovery contracts for Forge's remote-first workflow.
They describe what a caller may infer from a result and the one safe next
action when a provider or transport fails.

## Governing rule

**GitHub's observed feature ref is repository durability truth.**

The workspace filesystem is an execution cache. A GitHub API call returning 2xx
is not enough: Forge reports a remote mutation successful only after reading the
ref back and matching the expected commit SHA.

## Contracts

### 1. Workspace creation cannot lose its recovery handle

Creation returns the accepted `workspace_id` and `operation_id` within the MCP
host request budget. The returned state may be `provisioning`; that is a valid
accepted result. Observe the same workspace with `forge_workspace_get` or the
operation with `forge_operation_get`, passing the returned id in the
`workspace` field until a semantic branch address exists. Never start a duplicate merely because
provisioning outlived one response.

If the workspace registry itself is unavailable, resolution returns
`FORGE_PROVIDER_UNAVAILABLE`, `retryable:true`, a bounded `cause`, and a next
action that explicitly says to retry the same call rather than create another
workspace.

### 2. Repository paths never escape the checkout

Public paths are repo-relative or absolute at/below `/workspace/repo`. The
shared helper rejects `/workspace`, Forge metadata, temporary directories,
sibling-prefix tricks, `..`, empty input, and NUL bytes. Both GitHub reads and
container fallbacks use the validated normalized path.

### 3. An edit is remote or it is not successful

`forge_edit` reads the selected branch, applies the requested change, builds a
commit, updates the guarded `forge/*` ref, then reads it back. A successful
receipt contains the remote commit identity. If read-back does not match,
Forge returns a retryable push/provider failure and does not claim durability.

Retry the same intended edit with the same idempotency key. Do not vary the
content speculatively: the key exists to resolve an uncertain response without
creating a second commit.

### 4. Branch creation collisions are verified

GitHub HTTP 422 is not automatically treated as "already created." Forge reads
the colliding ref and adopts it only when its SHA equals the requested base SHA.
Other validation failures, or a different existing tip, are surfaced as stable
errors rather than a false creation receipt.

### 5. Raw push cannot bypass remote-first guards

`forge_shell` refuses visible `git push` commands, including common shell/env
wrappers and Git global options. Approval does not make them runnable. Use
`forge_edit` for remote commits and `forge_merge` for the review path.

This classifier is one policy layer, not the sandbox boundary; command
obfuscation is still bounded by sandbox credentials and egress controls.

### 6. Shell verification runs the intended code

Before foreground or background verification starts, Forge synchronizes the
checkout to the selected remote feature branch. A synchronization failure is
returned before the command starts, so a green test cannot describe stale code.

### 7. Background completion reports two durability layers

`forge_process_wait` is observational and bounded to one host-safe interval.
`timedOut:true` means the process continues; retry the wait and do not restart
the command.

When a successful background process changed repository files, finalization
reports:

| Field | Meaning |
| --- | --- |
| `filesystemCheckpointed` | local execution state was checkpointed |
| `committed_files` | repository paths included in the remote commit attempt |
| `commit_sha` | resulting Git commit, when one was created |
| `remote_persisted` | GitHub ref read-back matched that commit |
| `committed_files_warning` | why changed files were not safely committed, when applicable |

Only `remote_persisted:true` supports a claim that background repository
changes survived the workspace.

### 8. PR readiness includes every enforced GitHub gate

`forge_pr` status reads the current head, check runs, classic commit statuses,
required review decision, draft/state, and mergeability. A blocked merge state
is not safe merely because no textual conflict was found. Merge and close
repeat the live read, bind idempotency keys to one exact intent, and require
human approval, so an earlier green status cannot authorize newer commits.

### 9. Branch deletion is ownership- and SHA-safe

Deletion refuses a branch used by a live workspace. It checks merge policy,
then immediately re-reads the ref and requires the expected SHA before deleting
by name. A tip that moved after listing is refused rather than lost. Batched
merged-branch cleanup paginates the whole branch set or reports truncation.

### 10. Provider errors retain cause and recovery

Failures crossing Durable Object or provider boundaries preserve stable Forge
codes. Retryable infrastructure faults include a bounded cause and explicit
next action. They are never translated into user-validation states such as “no
workspace” or “file missing,” which would encourage a harmful alternative
action.

### 11. Artifact recovery is independent and bounded

`forge_artifact_get` returns image content directly, bounded text content, or
bounded base64 for other binary artifacts. Artifact authorization is scoped to
the owning tenant and exact project/workspace; a live container response is not
required to authorize recovery data.

## Operator checks

When investigating an uncertain mutation:

1. Read `forge_observer_activity` with `errors_only:true` for the stable Forge
   code and bounded cause.
2. Use `forge_operation_get` when an `operation_id` exists.
3. Read the GitHub feature ref or the tool's verified remote receipt before
   claiming repository durability.
4. Reuse the original idempotency key only for the same intended change.
5. Do not create a second workspace, restart a managed process, or issue a raw
   push as a generic recovery step.
