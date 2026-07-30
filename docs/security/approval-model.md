# Approval model

Approvals record requester, actor/client, repository, branch, exact command/diff, side effects, risk, expiry and the capability granted.

GitHub reads and guarded `forge_edit` commits to a `forge/*` branch normally proceed. Dependency installation and arbitrary executor network access are policy-dependent. PR mutation, public preview, production credentials, deployments, and other external writes normally require approval. Raw executor `git push`, default-branch writes, plaintext long-lived credentials, and audit bypass are prohibited.
