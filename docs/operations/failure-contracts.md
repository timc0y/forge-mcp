# Failure Contracts

## Governing Rules
1. **GitHub is Single Source of Truth**: Success requires reading back the ref SHA.
2. **Executor Files are Ephemeral**: Output is never auto-committed; marked `remote_persisted:false`.
3. **Explicit Repository Mutations**: Only `forge_edit` modifies repository files.

## Contracts Matrix

| Component | Behaviour on Failure / Boundaries |
| :--- | :--- |
| **Workspace Creation** | `forge_workspace_create` returns workspace/operation IDs without allocating compute. Faults return `FORGE_PROVIDER_UNAVAILABLE` with `retryable:true`. |
| **Path Resolution** | Restricts paths at or below `/workspace/repo`. Rejects `..`, sibling prefixes, and NUL bytes. |
| **Edits (`forge_edit`)** | Fetches HEAD, applies diff, creates commit, updates branch ref, reads back SHA. Reuse idempotency key only when retrying same diff. |
| **Executor Isolation** | File writes in sandbox are session-local. Sandbox recovery materializes fresh checkout from GitHub; local changes are lost unless written via `forge_edit`. |
| **Push Gating** | `forge_shell` blocks `git push` variants. Mutations must use `forge_edit` or `forge_merge`. |
| **Branch Collisions** | Returns 422 if branch exists; Forge inherits the branch only if current remote SHA matches the expected base SHA. |
| **Process Tracking** | `forge_process_wait` checks status in host-safe intervals. If `timedOut:true`, call wait again; do not restart process. |
| **PR Management** | `forge_pr` performs live reads of head, checks, reviews, and mergeability. Merges require explicit human approval. |
| **Branch Deletion** | Rejects deletion if branch matches a live workspace; recheck SHA immediately before deletion. |
| **Error Handling** | Infrastructure and provider issues return stable, action-oriented codes. |
| **Artifacts** | `forge_artifact_get` recovers logs/screenshots independently of the executor state. |

## Operator Troubleshooting Checklist
1. Inspect `forge_observer_activity` with `errors_only:true`.
2. Inspect operational status using `forge_operation_get`.
3. Rely on GitHub ref verification as the final source of truth.
4. Use unique idempotency keys for new mutations.
5. Avoid duplicate workspace allocation or raw shell pushes for recovery.
