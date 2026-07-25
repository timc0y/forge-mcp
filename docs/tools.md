# Tool reference

The canonical list of Forge MCP tools, as registered in
[`packages/mcp-core/src/index.ts`](../packages/mcp-core/src/index.ts). Every
name and description below is taken verbatim (or trivially shortened) from
that file — if the two ever disagree, the source file wins.

Each tool also carries a `sideEffect` (`none` / `workspace` / `external` /
`destructive`) and an `approval` mode (`none` / `policy` / `required`) noted
inline. `policy` means Forge's shell/network policy decides whether a real
user-approval page is required; `required` always needs one.

## Repositories and review (no workspace needed)

| Tool | Approval | Description |
| --- | --- | --- |
| `forge_repository_list` | none | List GitHub repositories currently authorized through the Forge GitHub App for this account. |
| `forge_review` | none | The cheapest Forge path: capture screenshot and accessibility evidence from an existing URL without starting a container, ready for a strict Parallax review. Flags heading-structure defects (stacked/empty/duplicated headings, skipped levels) that a screenshot alone hides. |

## Durable tasks

A task is a persistent coding-session record; none of these tools start a container.

| Tool | Approval | Description |
| --- | --- | --- |
| `forge_task_start` | none | Create a durable coding-session record that survives MCP reconnects, context compression, and container sleep. Call first for any coherent piece of work; attach a workspace later only when execution is needed. |
| `forge_task_get` | none | Return the full durable task record: branch, workspace, previews, files read/changed, checks, evidence ids. |
| `forge_task_summary` | none | Return a compact reconnect summary (goal, decisions, non-goals, state, files, checks, evidence, outstanding work, next recommended action) so a fresh turn can resume without replaying the session. |
| `forge_task_list` | none | List recent durable tasks for the account, most-recently-updated first, optionally filtered by state. |
| `forge_task_finish` | none | Move a task to a terminal state (`complete` / `failed` / `cancelled`). The record and its evidence stay retrievable afterwards. |

## Workspace lifecycle

| Tool | Approval | Description |
| --- | --- | --- |
| `forge_workspace_create` | none (workspace side effect) | Create a disposable isolated workspace from an authorized repository. Returns immediately with state `requested`; poll `forge_workspace_get` until `ready` (usually under a minute). |
| `forge_workspace_get` | none | Return lifecycle, repository, revision, processes, previews, snapshot, and outstanding state for one workspace. |
| `forge_workspace_destroy` | policy (destructive) | Revoke previews and capabilities, stop processes, destroy the sandbox, and mark the workspace destroyed. |

## Context and diff insight

Deterministic, model-free tools — no embeddings, syntax-only analysis.

| Tool | Approval | Description |
| --- | --- | --- |
| `forge_context_get` | none | Rank the most relevant repository files for a goal deterministically. Returns paths with reasons, governing instructions, adjacent tests, and package context — never file contents; the client decides what to read. |
| `forge_diff_metadata` | none | Summarize the outgoing diff: changed files, additions/deletions, changed exports, tests, config, migrations, possible secret exposure, risk areas, suggested hunks, and targeted verification suggestions. Syntax-only — inspect the raw diff via `forge_git_outgoing_diff` before any Git mutation. |

## Files

| Tool | Approval | Description |
| --- | --- | --- |
| `forge_files_tree` | none | Return a bounded, Git-aware file tree rooted inside `/workspace`. |
| `forge_files_read` | none | Read one file (`path`) or several at once (`paths`) as bounded text, each with a content hash for conflict-safe edits. |
| `forge_files_write` | none (workspace side effect) | Create or overwrite a file with full content — simpler and more reliable than a diff for whole-file changes. Pass `expected_sha256` for a conflict-safe overwrite. |
| `forge_files_patch` | none (workspace side effect) | Apply a unified diff inside the repository. Best for surgical multi-hunk edits; prefer `forge_files_write` for whole-file rewrites. |

## Shell and processes

| Tool | Approval | Description |
| --- | --- | --- |
| `forge_shell_exec` | policy | Execute a foreground command in an explicit directory with timeout, output, and network-policy bounds. Risky commands return a real user-approval URL. |
| `forge_process_start` | policy | Start a long-running process (e.g. a dev server) and return a Forge process identifier immediately. |
| `forge_process_logs` | none | Read a bounded process-log page using an opaque cursor. |

## Git and pull requests

| Tool | Approval | Description |
| --- | --- | --- |
| `forge_git_status` | none | Return structured working-tree and branch status. |
| `forge_git_diff` | none | Return the working-tree or staged diff one page of files at a time. Always returns the complete changed-file list; `diff` holds that page's hunks. See [Paged diffs](#paged-diffs). |
| `forge_git_branch_create` | none (workspace side effect) | Create and check out a local branch under the required `forge/` namespace. |
| `forge_git_commit` | none (workspace side effect) | Stage selected paths and create a commit attributed to `forge-mcp[bot]`. Omit `message` to auto-generate a conventional-commit message from the diff (Workers AI). |
| `forge_git_outgoing_diff` | none | Return the diff between the base branch and the current Forge branch, one page of files at a time, plus `diffHash` over the whole change — call this before any push/PR approval. See [Paged diffs](#paged-diffs). |
| `forge_git_push` | **required** (external) | Push a non-default `forge/` branch through the GitHub App credential proxy. Always needs a real user-approval page. |
| `forge_pull_request_create` | **required** (external) | Create a draft GitHub pull request for an already-pushed Forge branch. Omit `title` to auto-generate title/body from the diff. Always needs approval. |

## Preview and browser evidence

| Tool | Approval | Description |
| --- | --- | --- |
| `forge_preview_expose` | policy | Expose a running process through a short-lived Forge preview capability. Private by default; `public` access requires approval. |
| `forge_review_capture` | none (workspace side effect) | Capture screenshot + accessibility evidence of a running Forge preview across bounded routes, states, and viewports. Optional `steps` drive real interactions (click/fill/press/wait) before the shot, so a multi-step flow (open a menu, submit a form) can be proven, not just a static screenshot. This is the only preview-evidence tool. |
| `forge_artifact_get` | none | Return a stored Forge artifact (e.g. a screenshot) to the MCP client; image artifacts come back as MCP image content for direct model inspection. |

## Paged diffs

A diff is the one Forge result whose size is set by the user's repository
rather than by anything Forge chooses — one generated file, a vendored bundle
or a large content change can run to megabytes. `forge_git_diff` and
`forge_git_outgoing_diff` therefore return **a page of files at a time**:

| Field | Meaning |
| --- | --- |
| `files` | Every changed file with `additions` / `deletions` / `binary`. **Always complete**, on every page — it comes from `--numstat`, whose size scales with file count, not content. |
| `totalFiles`, `totalAdditions`, `totalDeletions` | Totals for the whole change, not the page. |
| `diff` | Unified diff for this page's files only. |
| `pageFiles` | The paths whose hunks are in `diff`. |
| `nextCursor` / `hasMore` | Call again with `cursor: nextCursor` for the next page. |
| `truncated` | A single file was too large to include whole. Paging will **not** return the rest — read it with `forge_files_read`. |
| `note` | One sentence stating what you are holding and the next call to make. |

Inputs: `cursor`, `max_bytes` (default 64 000), and `paths` — pass `paths` to
jump straight to specific files instead of paging up to them.

`forge_git_outgoing_diff` additionally returns `diffHash`, computed inside the
container over the **complete** diff. It is identical on every page and is safe
to carry into `forge_git_push` from any of them. (Previously the hash was taken
over the Worker-side stdout, which was silently truncated at 1 MB — so a large
change could be approved and pushed against a hash covering only its first
megabyte.)

Push-envelope checks and the envelope's default allow-list are derived from
`git diff --name-only` over the whole change, never from a page's hunks, and
fail closed if the path list cannot be enumerated in full.

## No MCP-UI widget

Forge serves no MCP Apps (`ui://`) resource and no tool declares
`_meta.ui` or `_meta['openai/outputTemplate']`. Every host — ChatGPT included —
renders tool results with its own plain text/structured output. The only
`_meta` a tool carries is the short `openai/toolInvocation/{invoking,invoked}`
status strings.

Approvals are the one Forge-authored screen: tools that need one return an
`approval_url` pointing at the hosted Approve / Deny page at `/approvals/:id`.
See [connectors.md](connectors.md#no-in-chat-widget).

See [connectors.md](connectors.md) for the OAuth flow and how ChatGPT/Claude
connect to this tool set.
