# Cloud cost runbook

> This is a proposed cost-control runbook. The referenced `@forge/cost` package
> and its runtime counters are not present in this workspace.

Target: below approximately USD 10 per month for one heavy personal user. All
figures are **estimates**, not Cloudflare billing.

## Monitor

When implemented, track `UsageCounters`: workspace active/idle ms, browser session ms, browser
captures, dependency installs, builds, command count, stored artifact bytes.
`budgetPosition(usage)` yields the estimated monthly USD and a level.

## Thresholds and response

| Level | Estimate | Action |
| --- | --- | --- |
| ok | < $5 | none |
| warning | ≥ $5 | surface budget on responses |
| strong-warning | ≥ $8 | surface prominently; prefer container-free actions |
| hard | ≥ $10 | refuse new cloud workspaces; allow cleanup, metadata, summaries and compute-free Git |

The proposed `gateComputeAction` would enforce the hard ceiling for workspace
creation while keeping cleanup and compute-free paths open.

## Keep costs low

Reuse one workspace per coherent task; ~90s idle sleep; destroy on durable
completion; prefer `forge_review` (no container) for deployed URLs; run narrow
checks before full builds; capture browser evidence only when deliberate.
