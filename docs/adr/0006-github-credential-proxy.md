# ADR 0006: GitHub credential proxy

- **Status:** accepted; amended 2026-07-30
- **Isolation:** No installation token is injected into sandboxes.
- **Proxy:** Short-lived Forge capability authorizes credential proxy to mint fresh token for clone/fetch.
- **Mutations:** Repository mutations use GitHub API; proxy avoids converting executor changes to pushes.
- **Capability Claims:** Bind workspace, repository, operation, expiry, and nonce.
