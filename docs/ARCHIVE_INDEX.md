# Archive Index of Completed Plans & Historical Logs

This document consolidates completed development milestones, old product/workflow plans, and resolved incident reviews to reduce workspace clutter.

---

## 1. Historical Autopsies & Session Reviews

### Autopsy: EasyRoads Session Stuck on `requested` (2026-08-02)
*   **Incident**: Agent stalled polling `forge_observer_*` waiting for a transition from `requested` to `ready`, assuming the executor provisioning had failed.
*   **Cause**: The agent did not understand that `requested` is a healthy, lazy-create control plane state that uses zero active compute until an execution tool runs.
*   **Resolution**: Enriched observer output with `lifecycle`, `executor_state`, and `allowedNextActions` fields. Enforced a `stop_polling` warning after 3 identical polls.

### Review: Deep Edge-Case Session Sims AF–AL (2026-08-02)
*   **Incident**: Deeper agent simulation loops identified seven edge-case vulnerabilities.
*   **Resolutions**:
    *   **AF (Omitted screenshots)**: Direct agent to `galleryUrl` and inform that `screenshot.artifactId` is absent for omitted cells.
    *   **AG (`workspace_id` param)**: Allowed `workspace_id` as a valid alias input parameter for `workspace`.
    *   **AH (Check fail force-merge)**: Removed error suggestions of `force:true` to block agents from self-approving failing check PRs.
    *   **AI (Dead workspace resume)**: Report `workspace_unavailable: true` on task resume so the agent knows to recreate the workspace.
    *   **AJ (Alternate poll storms)**: Enforce cross-tool observation warnings in activity trails to prevent escaping the 3-poll limit.
    *   **AK (Wrangler stdout deploy)**: Prevent the agent from guessing deploy URLs from wrangler shell logs; direct to `forge_deploy` to get a verified receipt.
    *   **AL (Visual check bypass)**: Destroy idle slots to free up preview resources, requiring manual confirmation before accepting diff-only approvals.

### Review: Conversational Flaws & Spirals 1–5 (2026-08-01)
*   **Incident**: Found five patterns of agent command loops.
*   **Resolutions**:
    *   **Flaw 1 (Timeout waits)**: Standardized `observationalWaitNextStep()` to enforce ≤30s wait tool polls.
    *   **Flaw 2 (Provisioning gets)**: Enforced `EXECUTOR_PROVISIONING_NEXT_STEP` to prevent creating duplicate workspaces while wait-polling.
    *   **Flaw 3 (Sequence violations)**: Blocked shell/edit calls before creation, blocked duplicate workspaces via `FORGE_WORKSPACE_CONFLICT`, and disabled edits on merged tasks.
    *   **Flaw 4 (Multi-turn conflicts)**: Disabled file overwrites when reads are truncated; require fresh idempotency keys on file conflicts.
    *   **Flaw 5 (Shell write spirals)**: Blocked write commands (`sed`, `>`, `tee`) and git mutations (`git add`, `git commit`) inside `forge_shell`. Implemented the \(\Phi\)-gate progress metric to block long test loops that do not make durable commits to GitHub.

### Review: Basic Short-Session Traps AM–AS (2026-08-02)
*   **Incident**: Typos and basic CRUD checks triggered seven agent session traps.
*   **Resolutions**:
    *   **AM (Destroyed ID reuse)**: Rejects reads/writes on destroyed workspaces, directing the agent to create a new session.
    *   **AN (Process-free get loops)**: Process-free operations (create, destroy) report `completed` immediately rather than staying `accepted`.
    *   **AO (Folder relative paths)**: File lists return full repo-relative paths to prevent agents from stripping subdirectory prefixes on subsequent reads.
    *   **AP (Guarded branch cuts)**: Prevented `forge_start` from cutting branches if a live workspace is already using them.
    *   **AQ (Legacy default branches)**: Made the `ref` argument optional; fall back to default repo branches to prevent 404s on non-`main` defaults.
    *   **AR (Markdown-only deps checks)**: Markdown edits bypass dependency installs and tests, proceeding directly to `forge_merge`.
    *   **AS (PR approval status)**: Gated `forge_merge` responses with `approval_required: true` and `pr_url: null` to avoid fake PR claims.

### Autopsy: Git Commit Durability Incident (2026-07-27)
*   **Incident**: Files written in a workspace were reported as "saved on the branch" but were lost on container reap because they were never pushed to GitHub.
*   **Cause**: Auto-push threw errors on write tools, which caused retry loops that tripped git dirty check errors ("nothing to commit"), leaving commits stranded.
*   **Resolution**: Auto-push results are returned as status data (`reconcileDurability`), not exceptions. Added continuous push retries based on `hasUnpushedWork`. Gracefully handle "nothing to commit" no-op returns. Added a strict `durability` schema (`local_only` | `remote_branch` | `pull_request` | `failed_recovered`) to all write tools.

---

## 2. Completed Development Plans

### Milestone Plan 0.5 (July 2026)
*   **Status**: Completed. Deliverables (basic workspace DO, DO coordinator recovery, lazy executor allocation, and `git-core` remote checks) are active in the codebase.

### Workflow: ChatGPT-First Handoff (July 2026)
*   **Status**: Completed. Defined the 11-step client development workflow loop spanning container-free context selection, git branch creation, file mutations via `forge_edit`, lazy container boots, test verification, and PR merge approval paths.

### Memory: Durable Task Memory (July 2026)
*   **Status**: Completed. Introduced the **Task** abstraction (`packages/task-core`) that lives above temporary workspaces to preserve goal/checklist state across connection drops. Backed by D1 `tasks` tables and optimistic revision concurrency guards.

### Insight: Context, Diffs & Verification (July 2026)
*   **Status**: Completed. Introduced `@forge/insight` to handle token-based file ranking (`selectContext`), unified diff syntax parsing (`analyzeDiff`), and mapping modified paths to validation tests (`suggestChecks`) container-free.

### Strategy: ChatGPT-First Master Plan (July 2026)
*   **Status**: Completed. Established the core promise: ChatGPT does the reasoning, and Forge supplies a cheap, secure, remote-first computer that exposes direct GitHub mutations and verification evidence.

---

## 3. Historical Handover & Reconciliation Records

### Handover: Forge State of Play (2026-07-29)
*   **State of Play**: Recorded post-release updates for remote-first `forge_edit` pathways. Highlights the E2E verification loop, lazy container provisioning to bypass 60s client timeouts, occupied branch deletion blocks, and the 5 developer invariants (`invariants.test.ts`).

### Reconciliation: Repository Audit (2026-07-16)
*   **Audit Record**: Mapped the status of all active/merged branches (PR #1) and compared the existing tree structures (`product/`, `architecture/`, `plans/`, `operations/`, `security/`) before introducing the task memory and insight packages.
