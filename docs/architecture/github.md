# GitHub architecture

Forge uses a GitHub App. Repository authorization is verified at each external operation against tenant membership, project membership, installation state, repository inclusion, permission and branch policy.

A reusable installation token must never enter the sandbox. Private clone and push use a credential-proxy capability bound to subject, tenant, workspace, repository, operation, branch pattern, expiry and nonce. The proxy exchanges that capability for a fresh installation token and forwards only an authorized Git request.

The private pilot uses GitHub as the Forge account identity and synchronizes repositories selected in the `forge-mcp-cloud` installation. It supports private clone, `forge/` branch creation, bot-attributed commits, approval-gated push and draft PR creation. Installation and repository-removal webhooks revoke stale authorization; every credential-proxy request rechecks the current repository authorization before minting an installation token.

Generated commits use the visible `forge-mcp[bot]` identity and never claim human authorship. Push approval binds the exact outgoing diff hash, branch and repository so a changed workspace cannot reuse an earlier decision.
