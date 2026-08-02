# Approval model

Approvals record requester, actor/client, repository, branch, exact command/diff, side effects, risk, expiry and the capability granted.

GitHub reads and guarded `forge_edit` commits to a `forge/*` branch normally proceed. Dependency installation and arbitrary executor network access are policy-dependent. PR mutation, public preview, production credentials, deployments, and other external writes normally require approval. Raw executor `git push`, default-branch writes, plaintext long-lived credentials, and audit bypass are prohibited.

There are two approval shapes:

- **Deferred (`work.submit` / `forge_merge`)** — the agent stages work and finishes. The human decides from the portal minutes or days later; Forge opens the draft PR. These stay decidable while the deferred queue row is open (default TTL 14 days).
- **Sync (`shell.exec`, `cloudflare.deploy`, `pull_request.mutate`, `secret.attach`)** — the agent must stay alive and retry with `approval_id` after the human decides (default TTL 120 minutes). Pending sync approvals also appear on the portal review queue.
