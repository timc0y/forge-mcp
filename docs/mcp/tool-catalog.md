# Tool catalog

Forge exposes 11 MCP tools at `/mcp`, designed for ordinary chat rather than an
agentic control loop. GitHub is the durable repository plane; executor state is
private and ephemeral.

## Discover and read

- `forge_repositories` — list or filter repositories authorized through the GitHub App
- `forge_search` — find relevant repository paths and text without starting compute
- `forge_read` — read a bounded batch of repository files from GitHub

## Change

- `forge_edit` — create, delete, or precisely replace fragments in a bounded set of files; commits directly to a Forge branch

Read existing files before replacing them. Prefer fragment replacements for
small changes; whole-file content is for new or genuinely small files.

## Run and inspect

- `forge_run` — run a bounded command against the current remote branch; command filesystem effects are not durable edits
- `forge_screenshot` — capture a public URL or branch preview at named breakpoints; phone and desktop are the default evidence
- `forge_status` — recover a command, screenshot, deploy, submission, or merge that outlives one chat tool request; use `owner/repo#pr/<number>` for a pull-request address

Forge owns checkout, dependency setup, process waiting, preview startup, and
cleanup. The chat does not address workspaces or processes directly.

When a branch action is the first request that needs an executor, Forge waits
only briefly for cold startup. If the container is still provisioning, the
action returns `state: running`, a human-readable `progress_state`, and a
status URL. Call `forge_status` with the same `owner/repo#branch` only when
progress is needed; once it reports ready, retry the original public action.
No command, screenshot, deployment, or approval is started by the status
observation, and no workspace or process ID is part of the chat contract.

## Deploy and submit

- `forge_environments` — list saved deploy environments and environment-variable names, never secret values
- `forge_deploy` — deploy the current branch through a saved environment and return a verified URL or durable status handle
- `forge_submit` — prepare the current remote branch for human review and return the approval URL
- `forge_merge` — queue an existing pull request for human approval; Forge makes a draft ready, merges it, and verifies the GitHub receipt without another chat call

Secret values are managed in Forge and never returned through MCP. Submission
approval can finish after the chat ends; no follow-up model call is required.
