# Workspace reliability contract

Forge treats the GitHub feature branch as the authority for repository state.
The workspace checkout is a rebuildable execution cache. Durable Object and D1
fields record coordination state and receipts; they never substitute for the
remote ref.

## Remote-first mutation

`forge_edit` is the public repository-mutation primitive. It reads the current
branch tip, applies fragment or whole-file changes, creates Git objects through
the GitHub API, updates the guarded `forge/*` ref, and reads that ref back. It
reports success only when the observed remote SHA matches the expected commit.
An HTTP ref-update response by itself is not proof of durability.

Mutation retries carry an idempotency key, and concurrent calls carry an
expected revision or ref SHA where applicable. A branch collision is adopted
only when GitHub's existing ref points at the requested base SHA. Branch
deletion checks live workspace occupants and verifies the tip again immediately
before deleting.

Raw `git push` is refused by `forge_shell`, including common wrapper and Git
global-option forms. It would bypass authorization, expected-tip checks,
idempotency, remote read-back, and receipts.

## Reads and path isolation

`forge_files_list` and `forge_files_read` use the GitHub branch tip. They fall
back to the cached checkout only for a transient GitHub failure and label the
source explicitly. Both paths pass through the same helper: inputs must be
repo-relative or absolute at/below `/workspace/repo`. Forge rejects metadata,
temporary, sibling-prefix, traversal, empty, and NUL-containing paths before
either backend is called.

Fragment edits against a newly created workspace branch resolve against its
recorded base commit when the feature ref has not yet been published. The first
successful edit creates that exact feature ref; it never instructs callers to
invent a second branch or overwrite a whole file to recover.

## Transport and process completion

Workspace creation returns its accepted `workspace_id` and `operation_id`
within the host request budget. Provisioning may continue after the response;
call `forge_workspace_get` for the same workspace. A registry outage returns a
stable retryable provider error with its bounded cause and tells the caller not
to create a duplicate workspace.

Foreground shell work is bounded. Longer work returns a managed `process_id`.
Each `forge_process_wait` call observes for one host-safe interval; a timeout
does not terminate the process. When a successful background mutation is
finalized, the result distinguishes filesystem checkpointing from GitHub
durability and reports `committed_files`, `commit_sha`, and
`remote_persisted`. Callers must not claim remote persistence unless that last
field is true.

## Checkpoints and restore

- `forge_workspace_snapshot` captures a named provider snapshot including Git
  and ignored execution state needed for rollback.
- Checkpoints carry a normalized archive hash over paths, modes, and symlinks;
  capture and restore verify it before acknowledging success.
- Automatic recovery overwrites only a proven-empty restore target. A missing
  marker, partial mount, Git mismatch, or provider-probe failure fails closed.
- `forge_workspace_restore` is destructive and revision guarded. It never
  changes the GitHub feature branch implicitly.
- Workspace teardown refuses unsafe local-only state unless the caller uses the
  explicit destructive override.

## Runtime and capability truth

The container image installs Node 24 and Corepack. Provisioning verifies the
requested runtime from inside the sandbox before reporting ready. A mismatch is
a provisioning failure. `forge_capabilities` reports the session's current
tool and approval surface; observer tools expose live coordination state without
mutating it.

`/ready` is stricter than `/health`: it remains unavailable until required R2
credentials are configured and a workspace has completed a verified
backup/restore round trip.
