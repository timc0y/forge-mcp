# ADR 0007: Forge-owned preview gateway

**Status:** accepted

Clients receive Forge preview URLs, not raw Sandbox URLs. The gateway authenticates viewers, verifies preview state and expiry, proxies HTTP/WebSockets, strips control-plane credentials and revokes access when the process/workspace ends. Private is the default; public exposure requires approval.
