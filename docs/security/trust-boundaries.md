# Trust boundaries

1. Client to Edge Gateway: OAuth identity and request validation.
2. Gateway to application: normalized domain commands only.
3. Application to coordinator: revision, lease and idempotency checks.
4. Application to sandbox: no control-plane secrets; bounded operations.
5. Sandbox to network: policy-controlled egress and credential proxies.
6. Preview viewer to app: Forge capability or authenticated membership.
7. Forge to GitHub: fresh installation authorization per operation.
