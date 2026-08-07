# Capability tokens

- **Format:** Short-lived HMAC/JWT-style envelopes.
- **Scope:** Subject, tenant, workspace, repository, action, branch pattern, expiry, nonce.
- **Constraints:**
  - Not bearer access to general APIs.
  - Audience-specific, never logged.
  - Compared in constant time, rejected post-expiry.
  - Implicitly revoked if workspace/installation disabled.
  - High-risk Git operations disabled pending one-time nonce storage deployment.
