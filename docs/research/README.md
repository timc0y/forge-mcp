# Research

This directory holds dated platform research, current market evidence and the
historical investigations that produced Forge's invariants. Older files are
preserved as evidence; they are not automatically descriptions of the current
worker.

## Read first

- [Forge history tool learnings](./forge-history-tool-learnings.md) — production
  failures and the invariants they bought.
- [Market signal, 20 August 2026](./market-signal-2026-08-20.md) — Treg evidence
  for ChatGPT-to-GitHub, phone and visual-review workflows.

## Current architecture context

- [Context engine](../plans/context-engine.md) — active V2 architecture.
  Earlier fallback/provider suggestions are not the current direction; deployment
  proof remains separate from source implementation.
- [Repository intelligence](./repository-intelligence.md) — historical research
  behind V2, retained as evidence rather than a second implementation queue.
- [Executor alternatives](./executor-alternatives-2026-07.md) — why execution
  was ultimately removed rather than moved.
- [Adoption register](./adoption-register.md) — a dated dependency snapshot;
  check current package files before acting on a version.
- [`SIMPLE.md`](../../SIMPLE.md) — the current design profile and invalidation
  conditions.

## Historical ChatGPT evaluations

- [ChatGPT MCP host limitations](./chatgpt-mcp-chat-limitations.md) — research
  that shaped the ordinary-chat constraints; its agent-job interface proposal
  was superseded by the implemented five-tool surface.
- [Progress potential](./progress-potential.md) — executor-era control research,
  not part of the current worker.

When a historical note conflicts with `SIMPLE.md`, the current source or a dated
production trace, the latter wins.
