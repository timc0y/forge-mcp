# Threat model

## Adversaries

Repository content, package scripts, tests, generated commands, MCP clients, browser pages, uploaded data and third-party dependencies are untrusted.

## Principal threats

Credential exfiltration, SSRF/private-network scanning, dependency confusion, reverse shells, mining/fork bombs, disk and memory exhaustion, symlink traversal, cross-tenant access, preview abuse, malicious pushes, poisoned snapshots, log injection and approval spoofing.

## Controls

No ambient credentials; per-workspace isolation; provider-independent policy; deny-by-default egress modes; private-range blocking; resource/time/output bounds; path and symlink checks; capability tokens; revision and idempotency checks; branch restrictions; approval gates; secret scanning/redaction; preview revocation; auditable external effects.

## Residual risk

Command classification is not proof of safety. Forge relies on layered containment and conservative approval when intent cannot be reliably derived. Redaction is best effort; secret prevention is preferred over detection.
