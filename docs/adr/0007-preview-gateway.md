# ADR 0007: Forge-owned preview gateway

- **Status:** accepted
- **Routing:** Clients receive Forge preview URLs, not raw Sandbox URLs.
- **Gateway Duties:** Authenticate viewers, verify state/expiry, proxy HTTP/WebSockets, strip control-plane credentials, revoke access on workspace termination.
- **Visibility:** Private by default; public exposure requires approval.
