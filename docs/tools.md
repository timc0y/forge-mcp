# Tool reference

Forge currently exposes 43 MCP tools. The source of truth is
[`packages/mcp-core/src/index.ts`](../packages/mcp-core/src/index.ts), and the
machine-readable schemas are generated into
[`schemas/forge-tools.schema.json`](../schemas/forge-tools.schema.json).

The public workflow is remote-first: repository reads target the selected
GitHub branch, and `forge_edit` commits directly to that branch through the
GitHub API. A container is an execution cache for builds, tests, previews, and
tools that genuinely need a Linux process; it is not the durability boundary.

## Discover and observe

| Tool | What it does |
| --- | --- |
| `forge_capabilities` | Returns the session's workspace, Git, secrets, preview, and approval capabilities. |
| `forge_observer_workspaces` | Read-only snapshot of live workspace slots, tasks, and branches. |
| `forge_observer_workspace` | Read-only process, log-tail, and merged MCP activity for one workspace. |
| `forge_observer_activity` | Read-only account activity trail; payloads are redacted and bounded. |
| `forge_repository_list` | Lists repositories authorized through the Forge GitHub App. |

Observer tools never mutate sandboxes.

## Durable tasks

| Tool | What it does |
| --- | --- |
| `forge_task_create` | Creates a durable goal/decision/non-goal record before coherent work begins. |
| `forge_task_get` | Reads a task in `full`, `summary`, or reconnect-oriented `resume` mode. |
| `forge_task_list` | Lists recent tasks, optionally filtered by state or query. |
| `forge_task_update` | Records a handoff and/or finishes a task with an outcome. |

Tasks are container-free and survive MCP reconnects and workspace teardown.

## Branches and workspace lifecycle

| Tool | What it does |
| --- | --- |
| `forge_start` | Creates a `forge/<slug>` branch on GitHub from the requested base, with idempotent collision handling. Pass the returned branch as `ref` when creating a workspace. |
| `forge_workspace_create` | Accepts creation of an isolated workspace and returns `workspace_id`, `operation_id`, and current state within the host request budget. The state may still be `provisioning`. |
| `forge_workspace_get` | Returns compact state and `branch_policy`; use it to observe provisioning rather than creating a duplicate workspace. |
| `forge_workspace_destroy` | Tears down a workspace; destructive and revision/idempotency guarded. |
| `forge_operation_get` | Resolves an uncertain mutation result by its `op_...` handle. |
| `forge_workspace_snapshot` | Captures a named filesystem checkpoint before risky local execution. |
| `forge_workspace_restore` | Restores a checkpoint, destroying later uncommitted local state. |

Workspace creation is asynchronous at the transport boundary. A response with
`state: provisioning` is an accepted operation, not a failure. Reuse its
`workspace_id` and call `forge_workspace_get` with that id in its `workspace`
field; do not start a second workspace. Once a branch exists, the semantic
`owner/repo#branch` address remains preferable across long conversations.

## Repository reads and edits

| Tool | What it does |
| --- | --- |
| `forge_files_list` | Lists a bounded tree from the GitHub branch tip, falling back to the cached checkout only for transient GitHub failure. |
| `forge_files_read` | Reads one or several files from the GitHub branch tip with the same explicit fallback behavior. |
| `forge_edit` | Applies fragment replacements, whole-file content, creation, or deletion and commits the result directly to GitHub. Returns the remote commit URL and SHA. |
| `forge_diff_metadata` | Returns syntax-only changed-symbol, risk, classification, and suggested-hunk metadata. |
| `forge_context_get` | Ranks relevant repository paths and adjacent tests for a goal; file contents remain explicit reads. |

Paths are repo-relative or absolute at/below `/workspace/repo`. `/workspace`,
`/workspace/forge`, `/workspace/tmp`, sibling-prefix paths, traversal, and NUL
bytes are rejected before either GitHub or container access.

There is no public file-write/patch/commit/push pipeline. `forge_edit` is the
guarded remote mutation. Its read guard, expected branch tip, idempotency key,
commit receipt, and remote read-back keep retries and concurrent changes safe.

## Shell and managed processes

| Tool | What it does |
| --- | --- |
| `forge_shell` | Runs a command for up to 30 seconds in the checkout, preserving request budget for synchronization and remote ingestion. Longer work returns a `process_id`. Risky commands follow shell/network approval policy. |
| `forge_process_list` | Lists managed processes or reads one in detail. |
| `forge_process_wait` | Observes a process for one host-safe wait window. A timeout is observational and does not kill or restart it. On successful mutation it reports committed files, commit SHA, and whether remote persistence was verified. |
| `forge_process_logs` | Reads incremental bounded logs with an opaque cursor. |
| `forge_process_stop` | Stops a managed process; `force:true` escalates cancellation. |
| `forge_deps_install` | Starts one managed dependency install and returns its process handle when still running. |

Repeat `forge_process_wait` when it returns `timedOut:true`; never restart the
underlying command merely because one observation ended. A successful
background command is not durable until `remote_persisted:true`. Inspect
`committed_files_warning` when files could not be committed remotely.

Raw `git push` is blocked in `forge_shell`, including shell wrappers and Git
global-option forms. It bypasses Forge's concurrency guards and verified
GitHub receipts. Use `forge_edit` for repository changes and `forge_merge` for
the review/merge path.

## GitHub history, branches, and pull requests

| Tool | What it does |
| --- | --- |
| `forge_access` | Explains repository authorization and proves read/write capability. |
| `forge_history` | Reads recent branch or file commit history without cloning. |
| `forge_branches` | Lists branch tips and proved merged state inside a host-safe budget, or deletes with immutable live-workspace, expected-SHA, merge, and idempotency guards. Large lists explicitly report truncation. |
| `forge_pr` | Lists PRs, reads live merge readiness, merges, or closes. Readiness includes checks, classic statuses, required reviews, and GitHub mergeability. Merge and close re-read the current head and require human approval. |
| `forge_merge` | Opens the PR/review flow for the workspace branch and returns the human approval URL; it does not push because the branch is already remote. |

Treat `forge_pr` status as a point-in-time observation. Merge and close recheck
the head, bind a supplied idempotency key to one intent, and require an approval
for that exact mutation before changing GitHub.

## Deploy, previews, review, and artifacts

| Tool | What it does |
| --- | --- |
| `forge_cloudflare_deploy` | Runs approved Wrangler deployment with an attached Cloudflare secret. A stable idempotency key is required; slow deploys return a managed `process_id`, then the same key obtains the verified receipt without starting another deploy. |
| `forge_review` | Captures screenshot/accessibility evidence from a public URL without a workspace, within a 40-second host-safe budget. |
| `forge_preview_expose` | Exposes a running workspace process through an expiring private preview; public access needs approval. |
| `forge_preview` | Starts/exposes the app for at most 30 seconds when needed and captures workspace screenshots, optionally after interactions. |
| `forge_artifact_get` | Fetches stored images, text, or bounded base64 binary content. |
| `forge_artifact_upload` | Stores a base64-encoded binary file as a workspace artifact. |

Do not claim a deployment is live without `deploy_receipt.verified_url`, or a
review journey passed without inspecting the returned evidence.

## Secrets

| Tool | What it does |
| --- | --- |
| `forge_secret_list` | Lists labels, providers, and environment-variable names; never values. |
| `forge_secret_create` | Stores encrypted environment variables under a label. |
| `forge_secret_update` | Updates the label, provider, or encrypted variables. |
| `forge_secret_delete` | Permanently deletes and detaches a secret. |
| `forge_secret_attach` | Attaches an approved secret to one workspace, or detaches with `attached:false`. |

Secret values never appear in list results, activity payloads, or workspace
metadata.

## Result and retry rules

- Mutating tools use `idempotency_key`; use a fresh value per intended change
  and reuse it only when retrying that same change.
- Revision/SHA guards reject stale callers instead of overwriting newer work.
- Provider or registry outages use stable retryable Forge errors and preserve a
  bounded cause plus the next safe action.
- A GitHub write is durable only after reading the remote ref back and matching
  the expected SHA. An HTTP update response alone is not proof.
- Large command output spills to an artifact instead of expanding the MCP
  response without bound.

No tool declares an MCP-UI output template. Hosts render Forge's structured
results directly; approval URLs point to Forge's hosted approval page.
