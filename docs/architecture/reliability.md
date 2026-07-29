# Workspace reliability contract

Forge has two deliberately separate planes:

- **GitHub control plane:** the sole durable authority for repository file
  CRUD, diffs, commits, branches, history, and pull requests.
- **Executor plane:** lazy, isolated, ephemeral compute for shell commands,
  dependency installs, builds, tests, dev servers, previews, and deploys.

The executor is never a repository durability boundary.

## Repository mutation

`forge_edit` is the only public tool that writes or deletes repository files.
It reads the selected GitHub branch, applies fragment or whole-file changes,
creates Git objects through the GitHub API, updates the guarded `forge/*` ref,
and reads that ref back. It reports success only when the observed remote SHA
matches the expected commit.

Mutation retries carry an idempotency key. Concurrent operations use content,
revision, head-SHA, or ref-SHA guards as appropriate. Branch collisions are
adopted only when the existing ref points at the requested base SHA. Branch
deletion refuses live-workspace refs and re-reads the target SHA immediately
before deletion.

Raw `git push` is refused by `forge_shell`. Commands cannot promote their
filesystem effects into GitHub implicitly.

## Repository reads and diffs

`forge_files_list`, `forge_files_read`, `forge_context_get`,
`forge_diff_metadata`, `forge_history`, `forge_branches`, and `forge_pr` read
GitHub directly. They allocate no executor and never substitute an executor
checkout for repository truth.

Public paths are repo-relative or absolute at/below `/workspace/repo`. Forge
rejects metadata, temporary, sibling-prefix, traversal, empty, and
NUL-containing paths before GitHub access or executor materialization.

## Control-plane workspaces and lazy execution

`forge_workspace_create` creates a lightweight coding session, records the
repository/branch and desired runtime/bootstrap settings, and immediately
returns `workspace_id` plus `operation_id`. It does not provision an executor.

The first shell, install, build, test, dev, preview, or deploy call allocates an
ephemeral executor and materializes the selected GitHub commit. Managed process
waits are bounded observations; `timedOut:true` never stops or restarts the
process.

Files created or modified by executor commands remain executor-only. Forge
never auto-commits them, and process results report `remote_persisted:false`.
If a command produced a wanted repository change, read or inspect it in the
executor and explicitly recreate it with `forge_edit`.

Destroying a workspace ends the control-plane session and discards executor
state. GitHub branches and `forge_edit` commits remain. Executor-only files are
intentionally lost, which is why tools must never describe them as remote or
durable.

## Capability truth

`forge_capabilities` reports the current tool and approval surface. Observer
tools expose control-plane and executor state without mutating either. Secret
values enter only the approved executor process that needs them and never
become GitHub content automatically.
