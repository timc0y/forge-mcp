# Approval model

## Approval Metadata
Approvals record: requester, actor/client, repository, branch, exact command/diff, side effects, risk, expiry, granted capability.

## Operation Policies
| Action | Policy |
|--------|--------|
| GitHub reads, guarded `forge_edit` commits to `forge/*` | Proceed normally |
| Dependency install, arbitrary network access | Policy-dependent |
| PR mutation, public preview, deployments, external writes | Require approval |
| Raw `git push`, default-branch writes, audit bypass | Prohibited |

## Approval Shapes
- **Deferred (`work.submit`)**: Agent stages work and finishes. Human decides later; Forge opens a draft PR. Default TTL 14 days. Failed steps get a Retry button.
- **Deferred (`pull_request.merge`)**: Forge pins an existing PR head and merge method. Human decides later; Forge rereads checks, makes a draft ready when approved, merges, and verifies the GitHub result. Default TTL 14 days. Failed steps get a Retry button.
- **Sync (`shell.exec`, `cloudflare.deploy`, `pull_request.mutate`, `secret.attach`)**: Agent stays alive and retries with `approval_id`. Default TTL 120 mins. Pending sync approvals appear on portal queue. One approval authorizes one action; shell may reuse identical command until TTL.
