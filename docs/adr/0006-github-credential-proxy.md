# ADR 0006: GitHub credential proxy

**Status:** accepted; implementation pending

No installation token is injected into a sandbox. A one-operation Forge capability authorizes a credential proxy to mint and use a fresh installation token. Clone, fetch and push policy are checked at the proxy, and capability claims bind workspace, repository, operation, branch, expiry and nonce.
