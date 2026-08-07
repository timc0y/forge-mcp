# Cloud Cost Runbook

**Ceiling**: ~$10/month per user (estimated).

## Monitoring Metrics (`UsageCounters`)
*   Workspace active/idle duration (ms)
*   Browser session time (ms) and capture count
*   Package dependency installation count
*   Code compilation build count
*   Storage usage for artifacts (bytes)
*   Workspace API command invocations

## Budget Gating

| Level | Monthly Cost | Surfaced UI Action | Workspace Creation |
| :--- | :--- | :--- | :--- |
| **ok** | < $5 | None | Allowed |
| **warning** | ≥ $5 | Budget shown in response headers | Allowed |
| **strong** | ≥ $8 | Highlighted warning; suggest container-free tools | Allowed |
| **hard** | ≥ $10 | Denied | Blocked (cleanups & metadata allowed) |

## Best Practices
Reuse workspaces per task; utilize container-free `forge_review` for deployed URLs; run narrow test checks; enforce ~90s idle container timeout.
