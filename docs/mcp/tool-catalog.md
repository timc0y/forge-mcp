# Tool catalog

Forge exposes 43 remote-first MCP tools from `forgeTools` in
`@forge/mcp-core`. Generated input/output schemas live in
`schemas/forge-tools.schema.json`.

## Discover and observe

- `forge_capabilities` — session capability/approval manifest
- `forge_observer_workspaces` — read-only live workspace/task/branch snapshot
- `forge_observer_workspace` — read-only process, log, and MCP activity bundle
- `forge_observer_activity` — bounded, redacted account activity trail
- `forge_repository_list` — authorized GitHub repositories

## Durable tasks

- `forge_task_create` — create goal, decisions, and non-goals
- `forge_task_get` — `mode`: `full` | `summary` | `resume`
- `forge_task_list` — recent tasks
- `forge_task_update` — finish and/or record structured handoff fields

## Branch and workspace

- `forge_start` — idempotently create a guarded remote `forge/*` branch
- `forge_workspace_create` — return accepted `workspace_id` + `operation_id`;
  state may still be provisioning
- `forge_workspace_get` — observe compact workspace and branch state
- `forge_workspace_destroy` — guarded destructive teardown
- `forge_operation_get` — resolve an uncertain `op_...` mutation
- `forge_workspace_snapshot` — named provider checkpoint
- `forge_workspace_restore` — guarded destructive rollback

The `workspace` field accepts the fresh `workspace_id` returned by create, as
well as `owner/repo#branch` or a bare branch. Use the id while provisioning has
not produced a branch yet; use the semantic branch address afterwards.

Workspace creation never waits behind provisioning long enough to lose its
recovery handles at the MCP transport boundary.

## Read and edit

- `forge_files_list` — bounded GitHub branch tree, with explicit transient
  container fallback
- `forge_files_read` — bounded GitHub branch file reads, with the same fallback
- `forge_edit` — fragment/full-file edit committed directly to GitHub
- `forge_diff_metadata` — syntax-only outgoing-diff metadata
- `forge_context_get` — ranked paths, adjacent tests, and governing instructions

Paths are repo-relative or absolute at/below `/workspace/repo`. Other absolute
workspace paths, sibling-prefix tricks, traversal, empty input, and NUL bytes
are refused by the shared helper used by both read backends.

## Shell and processes

- `forge_shell` — 30-second foreground budget, then managed background process
- `forge_process_list` — list all processes or inspect one
- `forge_process_wait` — observe for at most 30 seconds; repeat with the same
  process id after `timedOut:true`
- `forge_process_logs` — incremental log reads by cursor
- `forge_process_stop` — graceful or forced stop
- `forge_deps_install` — one managed install, returning its process handle

Successful background repository mutations distinguish
`filesystemCheckpointed` from `remote_persisted` and report
`committed_files`, `commit_sha`, and any `committed_files_warning`.

Raw `git push`, including common wrapper/global-option forms, is refused by
`forge_shell`. Use `forge_edit` for guarded remote commits and `forge_merge`
for review.

## GitHub and ship

- `forge_pr` — list/status pull requests; approval-gated, idempotent merge/close
- `forge_access` — diagnose/prove repository authorization
- `forge_history` — branch or file commit history
- `forge_branches` — bounded list or safe delete with immutable live-workspace
  and SHA guards; large lists report truncation
- `forge_merge` — open the approval-backed review path from the remote branch
- `forge_cloudflare_deploy` — approved managed deploy with a required stable key; slow runs return `process_id`, and the same key returns the verified receipt

GitHub writes are durable only after the expected ref SHA is read back. An HTTP
update response alone is not proof.

## Review, previews, and artifacts

- `forge_review` — screenshot/accessibility evidence for a public URL within a 40-second request budget
- `forge_preview_expose` — expiring private/public-gated process preview
- `forge_preview` — start/expose (30-second wait cap) and capture a workspace app with optional steps
- `forge_artifact_get` — fetch image, text, or bounded base64 artifacts
- `forge_artifact_upload` — store a base64 binary artifact

## Secrets

- `forge_secret_list` — metadata only; never values
- `forge_secret_create` — encrypt and store environment variables
- `forge_secret_update` — replace metadata or encrypted variables
- `forge_secret_delete` — permanently delete and detach
- `forge_secret_attach` — approved attach, or detach with `attached:false`

Secrets can also be managed in the portal at `/app/secrets`.
