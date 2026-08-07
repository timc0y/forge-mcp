# Tool reference

Forge exposes 10 MCP tools for direct chat from
[`packages/mcp-core/src/index.ts`](../packages/mcp-core/src/index.ts).

| Tool | Use it for |
| --- | --- |
| `forge_repositories` | Browse or filter GitHub repositories authorized for Forge. |
| `forge_search` | Find relevant paths and matching text before deciding what to read. |
| `forge_read` | Read a bounded batch of files directly from the selected GitHub branch. |
| `forge_edit` | Apply a small multi-file change and commit it remotely in one durable operation. |
| `forge_run` | Run a bounded command against the remote branch. Command-written files are not saved. |
| `forge_screenshot` | Capture a public URL or Forge branch preview at phone, desktop, or explicit breakpoints. |
| `forge_environments` | List saved deploy targets and variable names without revealing values. |
| `forge_deploy` | Deploy through a saved environment and return verified deployment evidence. |
| `forge_submit` | Queue the current branch for human review and return its approval URL. |
| `forge_status` | Recover long-running command, screenshot, deploy, or submission status. |

## Operating contract

- GitHub is the sole durable repository source of truth.
- Read before editing an existing file. Prefer precise fragment replacements.
- Forge creates and reuses its remote branch automatically.
- Commands, previews, dependencies, processes, and cleanup are internal details.
- Screenshot results attach evidence directly and state any omitted captures.
- Secret values stay in Forge's encrypted store and never enter model context.
- A successful mutation receipt is final: do not repeat it because a later step failed.
