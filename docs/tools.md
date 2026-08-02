# Tool reference

Forge currently exposes 45 MCP tools. The source of truth is
[`packages/mcp-core/src/index.ts`](../packages/mcp-core/src/index.ts), and the
machine-readable schemas are generated into
[`schemas/forge-tools.schema.json`](../schemas/forge-tools.schema.json).

GitHub's API is the sole repository plane for file CRUD, branch reads/writes,
diffs, commits, history, and pull requests. `forge_edit` is the only tool that
writes or deletes repository files. An executor is allocated lazily only for
shell, install, build, test, dev, preview, or deploy work; its filesystem is
ephemeral and never a source of repository truth.

## Discover and observe

| Tool | What it does |
| --- | --- |
| `forge_capabilities` | Returns the session's workspace, Git, secrets, preview, and approval capabilities. |
| `forge_observer_workspaces` | Live slots with lifecycle/executor_state; `requested` + empty processes is healthy lazy create. |
| `forge_observer_workspace` | Processes, logs, activity, plus lifecycle guidance; do not poll waiting for `requested`→`ready`. |
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
| `forge_workspace_create` | Creates a lightweight control-plane coding session and returns `workspace_id` and `operation_id` immediately. It records executor runtime/bootstrap preferences but allocates no executor. |
| `forge_workspace_get` | Returns compact control-plane, process, preview, dependency, and branch state. |
| `forge_workspace_destroy` | Ends the session and discards ephemeral executor state without changing GitHub. |
| `forge_operation_get` | Resolves an uncertain mutation result by its `op_...` handle. |

Workspace creation is a control-plane operation, not compute provisioning.
Reuse its `workspace_id` in subsequent calls. The first execution tool allocates
the executor; GitHub-only reads and edits never need one. Once a branch exists,
the semantic `owner/repo#branch` address remains preferable across long
conversations.

## Repository reads and edits

| Tool | What it does |
| --- | --- |
| `forge_files_list` | Lists a bounded tree directly from the selected GitHub branch without allocating an executor. |
| `forge_files_read` | Reads one or several files directly from the selected GitHub branch without allocating an executor. |
| `forge_edit` | Applies fragment replacements, whole-file content, creation, or deletion and commits the result directly to GitHub. Returns the remote commit URL and SHA. |
| `forge_diff_metadata` | Returns syntax-only metadata over the GitHub branch comparison. |
| `forge_context_get` | Ranks relevant GitHub repository paths and adjacent tests for a goal; file contents remain explicit reads. |

Paths are repo-relative or absolute at/below `/workspace/repo`. `/workspace`,
`/workspace/forge`, `/workspace/tmp`, sibling-prefix paths, traversal, and NUL
bytes are rejected before GitHub access or executor materialization.

There is no public file-write/patch/commit/push pipeline. `forge_edit` is the
guarded remote mutation. Its read guard, expected branch tip, idempotency key,
commit receipt, and remote read-back keep retries and concurrent changes safe.

## Shell and managed processes

| Tool | What it does |
| --- | --- |
| `forge_shell` | Lazily allocates an ephemeral executor and runs a command for up to 30 seconds. Longer work returns a `process_id`. Risky commands follow shell/network approval policy. |
| `forge_process_list` | Lists managed processes or reads one in detail. |
| `forge_process_wait` | Observes a process for one host-safe wait window. A timeout does not kill or restart it; executor filesystem effects always report `remote_persisted:false`. |
| `forge_process_logs` | Reads incremental bounded logs with an opaque cursor. |
| `forge_process_stop` | Stops a managed process; `force:true` escalates cancellation. |
| `forge_deps_install` | Lazily allocates the executor, starts one managed dependency install, and returns its process handle when still running. |

Repeat `forge_process_wait` when it returns `timedOut:true`; never restart the
underlying command merely because one observation ended. Command-created and
modified files remain in the ephemeral executor only. Forge never auto-commits
them. Recreate each wanted repository change with `forge_edit`; until then
`remote_persisted` is always false.

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
| `forge_deploy` | Approved deploy using attached vault secrets. The agent calls `forge_secret_list`, then passes `map_env` when vault keys differ from CLI names (e.g. `CF_KEY` → `CLOUDFLARE_API_TOKEN`). A stable idempotency key is required; slow deploys return a managed `process_id`, then the same key obtains the verified receipt. |
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
| `forge_secret_accounts` | Uses a stored Cloudflare API token to list account id+name (never returns the token). Pass `token_var` when the key is not `CLOUDFLARE_API_TOKEN` (e.g. `CF_KEY`). |
| `forge_secret_create` | Stores encrypted environment variables under a label. |
| `forge_secret_update` | Patches label/provider/env (env merges into existing vars so account id can be added without re-sending the token). `unset_env` removes keys. |
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
