# Cost controls

Status: archived proposal. `@forge/cost` is not present in this workspace, and
neither its model nor runtime enforcement is implemented.

## Target

Below approximately USD 10 per month for one heavy personal user. Cloudflare does
not expose per-request billing, so all figures are **estimates** derived from
metered usage — never claimed as precise dollars.

## Model

The proposed `@forge/cost` package would provide:

- `UsageCounters` — workspace active/idle ms, browser session ms, browser
  captures, dependency installs, builds, command count, stored artifact bytes.
- `estimateMonthlyUsd(usage, model)` — coarse, tunable unit costs.
- `Thresholds` — `warningUsd` (5), `strongWarningUsd` (8), `hardUsd` (10).
- `budgetPosition(usage)` → `{ estimatedMonthlyUsd, level, note }`.
- `gateComputeAction(position, action)` — at the hard threshold, refuse
  unnecessary new cloud workspaces while continuing to allow cleanup, repository
  metadata, task summaries and compute-free Git operations.
- `costMetadata(...)` — compact `{ backend, containerUsed, browserUsed,
  costClass, workspaceAgeMs, budget }` for attaching to tool responses.

## Behaviour at thresholds

| Level | Meaning | New cloud workspace |
| --- | --- | --- |
| ok | under warning | allowed |
| warning | ≥ $5 | allowed, surfaced |
| strong-warning | ≥ $8 | allowed, strongly surfaced |
| hard | ≥ $10 | refused (cleanup + compute-free still allowed) |

## Proposed runtime wiring

Accumulating real `UsageCounters` requires the workspace coordinator and
workflows to record active/idle time, captures and stored bytes, and a per-tenant
usage row. Attaching `costMetadata` to every relevant response and enforcing
`gateComputeAction` in `forge_workspace_create` are future implementation work.
