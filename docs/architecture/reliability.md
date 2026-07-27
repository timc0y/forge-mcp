# Workspace reliability contract

Forge treats the workspace filesystem and its Git repository as the authority for repository state. Durable-object and D1 fields are an observed record, never a substitute for Git objects.

## Mutation contract

`forge_files_write` is the whole-file mutation primitive. Forge writes the requested bytes, immediately re-reads the same absolute path through the same sandbox handle *and hashes it through the shell filesystem mount*, and only then returns success. Its receipt includes the workspace ID, path, prior and resulting SHA-256, filesystem revision, worktree hash (including untracked files), shell hash, and `readAfterWriteVerified: true`.

Every file mutation, mutating shell command, branch change and commit requires a provider checkpoint. If Forge cannot create that checkpoint, it does not acknowledge the enclosing mutation as successful. Cloudflare backup retention is seven days; use `forge_work_export` before risky or long-lived work to retain a recovery bundle in Forge artifacts.

All workspace mutations, shell operations, Git operations, process operations, previews, checkpoints, and exports require an explicit `workspace_id`. Forge never chooses an implicit current workspace.

## Git truth and submission

Provisioning records `baseCommit` and `initialHeadCommit` from the actual clone. Outgoing diffs and `forge_submit` compare against the immutable **requestedRef** recorded at workspace creation, not a mutable branch name like `main`. `forge_workspace_prove` returns the recorded and observed branch/HEAD, changed paths, worktree hash, outgoing committed hash, file hashes from the filesystem and HEAD, and remote branch agreement via `ls-remote` when GitHub auth is available.

Agent work on `forge/*` branches is auto-pushed to origin after each successful `forge_git_commit` unless `FORGE_AUTO_PUSH_FORGE_BRANCHES` is `false` or `0`. Task completion requires a verified **remote feature SHA** (`remoteBranchSha`); staging via `forge_submit` sets `submittedAt` only.

## Recovery

- `forge_workspace_checkpoint` creates a provider snapshot of the workspace including Git data.
- Checkpoints carry a normalized archive hash covering every path, file mode and symlink under `/workspace`, including Git-ignored content. Forge compares the hash before and after capture and after restore; a mismatch quarantines the recovered workspace rather than exposing it.
- Automatic sleep recovery runs only after Forge proves that the entire `/workspace` restore target is empty. A missing marker, a partial mount, a Git mismatch or a provider probe failure fails closed and never triggers an overwrite.
- `forge_workspace_restore` restores a saved checkpoint, but refuses to overwrite dirty or unpushed work. Explicit restore records only the selected, manifest-verified checkout identity; a failed restore verifies the rollback checkpoint before declaring recovery.
- Legacy checkpoints from before manifests are supported only after a confirmed mount-loss restore whose Git identity matches the recorded workspace. Forge immediately upgrades that checkpoint with a manifest.
- `forge_work_export` persists a recovery artifact containing committed and uncommitted binary diffs and a base64 `tar.gz` archive of every untracked file.
- Workspace teardown is blocked while the worktree is dirty or the checked-out branch/commit has not been recorded as pushed.

## Runtime and capability truth

The container image installs Node 24 and Corepack. Provisioning verifies the requested Node major version before it reports a workspace ready. A profile mismatch fails provisioning explicitly instead of returning a misleading ready workspace. `forge_capabilities` returns the session’s stable capability and approval manifest before work begins.

`/ready` is intentionally stricter than `/health`: it remains unavailable until the required R2 S3 credentials are configured **and** a workspace has completed a manifest-verified backup/restore round trip. This prevents configuration-only readiness from being mistaken for durable recovery.
