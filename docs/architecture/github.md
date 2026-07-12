# GitHub architecture

Forge uses a GitHub App. Repository authorization is verified at each external operation against tenant membership, project membership, installation state, repository inclusion, permission and branch policy.

A reusable installation token must never enter the sandbox. Private clone and push use a credential-proxy capability bound to subject, tenant, workspace, repository, operation, branch pattern, expiry and nonce. The proxy exchanges that capability for a fresh installation token and forwards only an authorized Git request.

The private pilot supports public clone only. Private repositories and Git writes stay disabled until the proxy, branch/commit/push tools, PR creation and webhook reconciliation are deployed and audited.
