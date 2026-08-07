# Cost Controls

**Status**: Archived proposal. `@forge/cost` and runtime meters are NOT implemented.

## Target
*   Budget ceiling: ~$10/month per user.
*   Cost calculations represent coarse, tunable estimates derived from metered telemetry.

## Proposed Model (`@forge/cost`)

*   **`UsageCounters`**: Track active/idle time (ms), browser duration, screenshot captures, dependency installs, compilation builds, command counts, and artifact storage.
*   **Thresholds & Actions**:
    *   `warningUsd` ($5): Inject warning into tool responses.
    *   `strongWarningUsd` ($8): Highlight budget warning, encourage container-free tools.
    *   `hardUsd` ($10): Block new workspace allocations; allow cleanups, metadata, and git metadata tools.

| Level | Estimate | Workspace Creation |
| :--- | :--- | :--- |
| **ok** | < $5 | Allowed |
| **warning** | ≥ $5 | Allowed (warned) |
| **strong-warning** | ≥ $8 | Allowed (highlighted) |
| **hard** | ≥ $10 | Blocked |

## Proposed Integration
Enforcement would live in `forge_workspace_create` using per-tenant database records updated by the workspace coordinator and execution workflow events.
