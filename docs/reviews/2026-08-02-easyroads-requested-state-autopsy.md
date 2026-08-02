# Forge autopsy — EasyRoads evaluation session stuck on `requested`

**Date:** 2026-08-02
**Status:** root-caused; observer diagnostics landed in the same change set
**Workspace:** `ws_3be6d622c5f560a9cf26fca397`

## Incident

A Forge-driven documentation session for EasyRoads completed a first-phase
documentation write, then entered what the agent treated as an unusable
workspace. Repeated `forge_observer_*` calls returned:

- `state = requested`
- branch available
- no running processes
- no activity / no logs

The agent never resumed GitHub reads or edits. Integration work (ADR links,
registry pointers, internal research READMEs, cross-links) did not finish.

## What actually happened

`forge_workspace_create` intentionally returns a lightweight control-plane
session. `state: requested` with no executor, no processes, and no log tail is
the **healthy lazy-create outcome**. GitHub CRUD (`forge_files_read`,
`forge_edit`, …) already works; the ephemeral executor starts only on the first
shell / install / preview / deploy call.

The session therefore did not fail at provisioning. The agent misread an empty
executor plane as a hung provisioner and polled the observer indefinitely.

There was no evidence of merge conflicts, repository corruption, or Git
failures. Edits already committed through `forge_edit` remained on the Forge
branch on GitHub.

## Incorrect inference

Three observer facts were treated as proof the workspace was broken:

1. `state` stayed `requested`
2. process list stayed empty
3. log tail stayed empty

All three are expected while the executor has never been allocated. The missing
distinction:

> A control-plane session with a GitHub branch ready is not the same thing as
> an executor that is still provisioning.

PR #56 already steered `forge_workspace_create` / `forge_workspace_get` away
from this trap. This session shows the **observer path** still lacked the same
signal: identical successful observer receipts gave no "stop polling, edit now"
diagnostic.

## Root cause

Primary (agent trap Forge invited):

- Observer detail for `requested` reported raw state / empty processes / empty
  logs without naming the lifecycle as healthy lazy control-plane.
- Repeated identical **successful** observer polls were not detected (repeat
  detection only enriched failing calls).

Contributing:

- Autopsy-style operator language ("unusable", "never transitioned") matched
  how a hung provision Workflow looks, so the agent kept waiting for a state
  change that was never supposed to happen without an execution tool.
- Durability of prior `forge_edit` commits was not restated on the observer
  receipt, so the agent could not tell committed work from pending work.

## Fixes in this change set

1. Observer list and detail include `lifecycle`, `executor_state`,
   `allowedNextActions`, `next_step`, and explicit guidance for `requested`.
2. Identical successful observer polls get a `stop_polling` diagnostic after
   the third identical call.
3. Observer receipts restate remote durability (`forge_edit` → GitHub) so empty
   executor state is not confused with lost edits.
4. This autopsy documents the EasyRoads session and the remaining product
   suggestions that are out of scope for the observer patch.

## Suggestions still open

These remain useful product follow-ups; they are not claimed fixed here:

1. Time out or escalate long-lived *true* provision stalls with richer stages
   (`queued`, `cloning`, `indexing`, `failed`) — already partially covered for
   `provisioning` / `bootstrapping` by the stuck-provision watchdog; do not
   treat healthy `requested` as that class of stall.
2. Expose provisioner logs when an executor wake actually fails.
3. Offer an explicit re-wake / re-provision action after a failed executor
   start without requiring a brand-new task.
4. Surface a compact "edits committed vs executor-only" summary on every
   workspace-facing receipt (partially addressed for observer here).

## Related

- [Workspace reliability contract](../architecture/reliability.md)
- [Project workflows — cost ladder](../mcp/project-workflows.md)
- [Branch incident autopsy](./2026-07-27-forge-branch-incident-autopsy.md)
- PR #56 — lazy requested guidance for create/get
