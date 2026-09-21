# Documentation

**[Context engine](./plans/context-engine.md)** — the active V2 architecture:
GitHub source, parser-backed structure, JEV evidence selection, exact-commit CI
evidence and compact context packets, without fallback chains or additional
hosted context services. Deployment proof is tracked separately.

**[Using Forge](./using-forge.md)** — the product vocabulary, current client
availability, setup, examples, tools and limits.

**[Product route](./plans/product-route.md)** — the active adoption,
measurement and revenue plan. This is where positioning and commercial
hypotheses live; the architecture plan stays architectural.

**[Operating Forge](./operating-forge.md)** — configuration, secrets, analytics,
cost, and the things that will bite. The
[account-deletion runbook](./account-deletion.md) is the manual privacy-control
procedure.

**[Going live](./going-live.md)** — everything between the current deployment
and strangers relying on it: production proof, hardening, privacy and review.

**[Forge V1 architecture](./plans/forge-v1.md)** — historical design record for
the five-tool, GitHub-first reset. Current behavior and invariants live in
`SIMPLE.md`.

**[Research](./research/)** — current platform notes and historical evidence.
Start with the dated
[ChatGPT availability note](./research/chatgpt-availability-2026-08-20.md), the
[market signal note](./research/market-signal-2026-08-20.md), and
[`forge-history-tool-learnings.md`](./research/forge-history-tool-learnings.md).
`SIMPLE.md` at the repository root carries the invariants that still bind.

**[Test runs](./test-runs/)** — traces recorded against production from clients
that may stop after any tool call. The latest is the
[20 August ChatGPT smoke run](./test-runs/production-chatgpt-smoke-2026-08-20.md).
