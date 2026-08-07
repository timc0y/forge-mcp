# Tool reference

Forge exposes 11 MCP tools for direct chat from
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
| `forge_merge` | Queue an existing pull request for human approval; Forge makes a draft ready, merges it, and verifies the GitHub receipt without another chat call. |
| `forge_status` | Recover long-running command, screenshot, deploy, submission, or merge status. Use `owner/repo#pr/<number>` for a durable pull-request address. |

### Branch preview configuration

Forge infers a root `package.json` `dev` script and a framework port. For a
monorepo, a custom server, or a non-standard port, commit `forge.json` at the
repository root:

```json
{
  "$schema": "https://raw.githubusercontent.com/timc0y/forge-mcp/main/schemas/forge-config.schema.json",
  "preview": {
    "cwd": "apps/web",
    "command": "pnpm dev --host 0.0.0.0",
    "port": 5173
  }
}
```

`cwd` stays inside the repository. `command` and `port` override inference;
omitting either keeps the detected package script or framework default. The
config contains no environment or secret fields. The package manager and lock
file still control dependency installation, with a root lockfile preferred for
workspace monorepos. `forge.config.json` is accepted as an alternate filename.

## Operating contract

- GitHub is the sole durable repository source of truth.
- Read before editing an existing file. Prefer precise fragment replacements.
- Forge creates and reuses its remote branch automatically.
- Commands, previews, dependencies, processes, and cleanup are internal details.
- Screenshot results attach evidence directly and state any omitted captures.
- Secret values stay in Forge's encrypted store and never enter model context.
- A successful mutation receipt is final: do not repeat it because a later step failed.
