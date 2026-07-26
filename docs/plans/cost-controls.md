# Cost controls

Status: model and thresholds implemented in `@forge/cost`; response-metadata and
usage-accumulation wiring pending live runtime counters.

## Target

Below approximately USD 10 per month for one heavy personal user. Cloudflare does
not expose per-request billing, so all figures are **estimates** derived from
metered usage — never claimed as precise dollars.

## Model

`@forge/cost` provides:

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

## Runtime wiring pending

Accumulating real `UsageCounters` requires the workspace coordinator and
workflows to record active/idle time, captures and stored bytes, and a per-tenant
usage row. Attaching `costMetadata` to every relevant response and enforcing
`gateComputeAction` in `forge_workspace_create` is the follow-up integration;
the model and gating logic are implemented and unit-tested now.
