# Security architecture

Forge applies zero-trust controls at multiple layers: OAuth subject validation, tenant/project authorization, workspace revision checks, leases, command classification, sandbox isolation, explicit network modes, scoped capabilities, output limits, redaction, approvals and immutable audit events.

No lower-level provider route is a policy bypass. Raw Sandbox preview routes are reachable only through an internal service capability; user-facing previews are authorized by Forge and expire independently.
