# Capability tokens

Capabilities are short-lived HMAC/JWT-style envelopes scoped to subject, tenant, workspace, repository, action, branch pattern, expiry and nonce. They are not bearer access to general Forge APIs.

Tokens are audience-specific, never logged, compared in constant time, rejected after expiry and revoked implicitly when a workspace or installation is disabled. High-risk operations use one-time nonce storage before Phase 2 production.
