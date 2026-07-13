# Approval model

Approvals record requester, actor/client, repository, branch, exact command/diff, side effects, risk, expiry and the capability granted.

Reads and local isolated edits normally proceed. Dependency installation and arbitrary network access are policy-dependent. Push, PR mutation, public preview, production credentials and external writes normally require approval. Default-branch push, plaintext long-lived credentials and audit bypass are prohibited.
