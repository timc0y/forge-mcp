# Documentation

- [Forge V1 plan](./plans/forge-v1.md) — the five tools, the phases, the cost model.
- [Research](./research/) — the record of what the first Forge learned.
- [Test runs](./test-runs/) — traces recorded against production from a client
  that may stop after any tool call. Measured behaviour, not inference: worth
  reading before assuming what a non-agentic host does with a result.

The single most valuable file here is
[`research/forge-history-tool-learnings.md`](./research/forge-history-tool-learnings.md):
a register of production failures and the invariants they bought. `SIMPLE.md` at
the repository root carries the ones that still bind.

Documentation of the previous runtime — architecture, operations, security,
tool catalogue — was removed with the implementation it described. It is in
this repository's git history.
