# GitHub Architecture

## Security & Auth

| Domain | Mechanism / Invariant |
| --- | --- |
| Integration | GitHub App (`forge-mcp-cloud`); GitHub acts as Forge identity. |
| Authorization | Verified per op against tenant membership, install state, repo inclusion, permissions, branch policy. |
| Tokens | Reusable tokens never enter executor; edge gateway mints narrowly-scoped installation tokens. |
| Revocation | Installation and repo-removal webhooks revoke stale authorization. |

## Source of Truth & Pipeline

- **Truth Plane:** GitHub API is sole plane for CRUD, diff, commit, branch, history, and PRs (executor checkouts non-authoritative; command FS writes remain local).
- **Identity:** Commits use `forge-mcp[bot]` identity (never human authorship).

## Tool Operations

| Tool | Action & Guardrails |
| --- | --- |
| `forge_start` | Creates `forge/*` ref with base-SHA / idempotency guard. |
| `forge_edit` | Sole file write/delete tool. Builds commit via GitHub API, updates guarded ref, reads back & verifies expected SHA for remote durability. |
| `forge_shell` | Refuses raw `git push` (bypasses expected-tip, idempotency, auth, read-back checks). |
| `forge_merge` | Opens human review path from remote feature branch. |
| `forge_pr` | Rechecks live head, statuses, reviews, mergeability; requires human approval bound to exact merge/close intent. |
