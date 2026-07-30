# ADR 0006: GitHub credential proxy

**Status:** accepted; amended 2026-07-30

No installation token is injected into a sandbox. A short-lived Forge capability authorizes the credential proxy to mint and use a fresh installation token for clone/fetch. Repository mutations use the GitHub API; the proxy does not turn executor changes into pushes. Capability claims bind workspace, repository, operation, expiry and nonce.
