# Tool catalog

Forge exposes 10 MCP tools at `/mcp`, designed for ordinary chat rather than an
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
- `forge_status` — recover a command, screenshot, deploy, or submission that outlives one chat tool request

Forge owns checkout, dependency setup, process waiting, preview startup, and
cleanup. The chat does not address workspaces or processes directly.

## Deploy and submit

- `forge_environments` — list saved deploy environments and environment-variable names, never secret values
- `forge_deploy` — deploy the current branch through a saved environment and return a verified URL or durable status handle
- `forge_submit` — prepare the current remote branch for human review and return the approval URL

Secret values are managed in Forge and never returned through MCP. Submission
approval can finish after the chat ends; no follow-up model call is required.
