# Failure contracts

These are the recovery contracts for Forge's GitHub control plane and ephemeral
executor plane.

## Governing rules

1. **GitHub's observed ref is repository durability truth.** A 2xx write is not
   sufficient; Forge reads the ref back and requires the expected SHA.
2. **Executor files are never repository files.** Command-created or modified
   files remain executor-only, are never auto-committed, and always have
   `remote_persisted:false`.
3. **Only `forge_edit` writes or deletes repository files.** Use it explicitly
   for every wanted durable file change.

## Contracts

### 1. Workspace creation returns a control-plane handle

`forge_workspace_create` returns `workspace_id` and `operation_id` within the
MCP host budget. It creates a lightweight session and allocates no executor.
Pass the returned ID as `workspace` on later calls. The first execution tool
allocates compute; do not create a duplicate session while that happens.

Registry failure returns `FORGE_PROVIDER_UNAVAILABLE`, `retryable:true`, a
bounded cause, and a next action that says to retry rather than create another
workspace.

### 2. Repository paths remain bounded

GitHub-facing paths are repo-relative or absolute at/below
`/workspace/repo`. Forge rejects `/workspace`, metadata, temporary directories,
sibling-prefix tricks, `..`, empty input, and NUL bytes before access.

### 3. An edit is remote or unsuccessful

`forge_edit` reads GitHub, applies the requested change, creates a commit,
updates the guarded feature ref, and reads the ref back. A successful receipt
contains the verified remote commit identity. Reuse the same idempotency key
only when retrying the same intended edit.

### 4. Executor writes are local by design

`forge_shell`, managed processes, dependency installs, builds, tests, dev
servers, previews, and deploy commands run in a lazy ephemeral executor.
Their filesystem effects are useful for that execution session but are never
auto-committed or pushed. Process results report `remote_persisted:false`.

A successful command proves only its exit status and captured evidence. It does
not prove that files it generated are on GitHub. Recreate wanted changes with
`forge_edit` before destroying the workspace. Executor snapshots can roll back
local experiments but do not strengthen repository durability.

### 5. Raw push cannot bypass the control plane

`forge_shell` refuses visible `git push` commands, including common shell/env
wrappers and Git global options. Approval does not make them runnable. Use
`forge_edit` for file commits and `forge_merge` for review.

### 6. Branch creation collisions are verified

GitHub HTTP 422 is not automatically treated as “already created.” Forge reads
the colliding ref and adopts it only when its SHA equals the requested base SHA.

### 7. Process waits are observational

Each `forge_process_wait` call observes for one host-safe interval.
`timedOut:true` means the process continues; call wait again with the same
`process_id` and do not restart the command. Completion never promotes executor
files into GitHub.

### 8. PR readiness includes enforced gates

`forge_pr` status reads the current head, check runs, classic statuses,
required review decision, draft/state, and mergeability. Merge and close repeat
the live read, bind idempotency keys to one exact intent, and require human
approval.

### 9. Branch deletion is ownership- and SHA-safe

Deletion refuses a branch used by a live workspace, checks merge policy, and
re-reads the ref SHA immediately before deletion. Large branch collections are
bounded and report truncation instead of guessing.

### 10. Provider errors retain cause and recovery

Provider and Durable Object failures preserve stable Forge codes. Retryable
infrastructure faults include a bounded cause and explicit next action; they
are never translated into misleading user-validation states.

### 11. Artifact recovery is independent and bounded

`forge_artifact_get` returns image content, bounded text, or bounded base64 for
binary artifacts. Artifacts and logs may outlive an executor, but they do not
turn executor filesystem changes into repository changes.

## Operator checks

When investigating an uncertain result:

1. Read `forge_observer_activity` with `errors_only:true`.
2. Use `forge_operation_get` when an `operation_id` exists.
3. Trust repository durability only from a verified GitHub receipt/ref.
4. Reuse an idempotency key only for the identical intended mutation.
5. Do not create a duplicate workspace, restart a managed process, or issue a
   raw push as a generic recovery step.
