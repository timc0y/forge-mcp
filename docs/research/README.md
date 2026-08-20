# Research

This directory holds dated platform research, current market evidence and the
historical investigations that produced Forge's invariants. Older files are
preserved as evidence; they are not automatically descriptions of the current
worker.

## Read first

- [Forge history tool learnings](./forge-history-tool-learnings.md) — production
  failures and the invariants they bought.
- [ChatGPT availability, 20 August 2026](./chatgpt-availability-2026-08-20.md) —
  current documented plan and surface constraints.
- [Market signal, 20 August 2026](./market-signal-2026-08-20.md) — Treg evidence
  for ChatGPT-to-GitHub, phone and visual-review workflows.

## Current architecture context

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
- [Ordinary Chat evaluation, 7 August 2026](./ordinary-chat-evaluation-2026-08-07.md)
  — evidence from the former ten-tool facade, retained for comparison.
- [Progress potential](./progress-potential.md) — executor-era control research,
  not part of the current worker.

When a historical note conflicts with `SIMPLE.md`, the current source or a dated
production trace, the latter wins.
