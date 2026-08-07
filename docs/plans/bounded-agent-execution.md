# Bounded Agent Execution Plane

Forge is a secure, durable, bounded execution layer for coding agents (ChatGPT, Codex, Claude). The reasoning is done by the client; Forge handles execution, evidence, and repository state.

```
Product/Engineering Intent
  └─► Durable Forge Task (Boundaries, Goals, Invariants)
        └─► Context Selection (Deterministic Ranking)
              └─► Ephemeral Workspace (On-demand compute)
                    ├─► Shell, Run, Inspect, Change, Verify
                    ├─► Human Approval (Privileged Action Gate)
                    └─► Evidence Capture & Teardown
```

## Problem Resolution Matrix

| Problem | Forge Solution |
| :--- | :--- |
| **Agent application setup waste** | Semantic operations like `forge_review(url, routes, states, viewports)` return structured visual/accessibility data. |
| **Setup logs consumption** | Converts stdout/stderr, process IDs, and setups into compact structured telemetry. |
| **Ambiguity in tool sequencing** | Scopes tools to: container-free reads -> start task -> lazy workspace -> metadata inspect -> approval check -> evidence check -> destroy. |
| **Host-specific environment drift** | Uniform abstraction: tasks, workspaces, processes, previews, evidence, artifacts, capabilities, and approvals. |
| **Context loss on reconnect** | Tasks persist goals, decisions, non-goals, files read/changed, checks, and evidence across sessions. |
| **Truth dilution** | Classifies assertions: *binding decision*, *verified fact*, *observed fact*, *inference*, *assumption*, *recommendation*, *stale*. |
| **Autonomy creep** | Tasks enforce explicit goals, non-goals, invariants, path limits, and stop conditions. |
| **Overprivileged execution** | Isolates tenant workspaces; enforces scoped capability tokens; requires approval for write/network actions. |
| **Approval context gaps** | Approval interface shows goals, non-goals, risks, checks, and exact revision-bound diff. |
| **Premature completion declarations** | Requires defined checks and evidence matches before a task is closed. |
| **Stale/detached evidence** | Binds evidence hashes to specific repository commit, branch, workspace revision, and viewport. |
| **Repeated failures** | Preserves predecessor task links, terminal root causes, and evidence. |
| **Premature container costs** | Prioritizes cheap metadata/deployed URL inspection over workspace creation. |

## Core Use Cases

1. **Snapshot Deployed App**: Capture routes, viewports, accessibility trees without a workspace.
2. **Cross-Host Continuity**: Resume tasks in a different client without replaying chat history.
3. **Remote Repo Inspection**: Filter likely context, search tasks, and check diff metadata container-free.
4. **Isolated Coding**: Lazily materialize workspace for a branch; mutate via `forge_edit`; run checks in sandbox.
5. **Human-Approved Mutation**: Generate revision-bound diff and signed approval link prior to push/PR.
6. **Durable Handoff**: Retrieve compact summary separating completed work, facts, assumptions, and next steps.
7. **Safe Failure**: Terminate task as failed/cancelled while preserving root cause and successor recommendations.

## Operating Principles

*   **Semantic Tools > Shell Rituals**: Focused APIs (e.g. `forge_edit`, `forge_review`) over raw shell loops.
*   **Cheap First**: Read metadata, git references, and deployed URLs before allocating compute.
*   **Disposable Compute**: Tasks contain memory; workspaces are ephemeral and easily destroyed.
*   **Bounded Authority**: Scoped directory access, command class gating, and strict network policies.
*   **Revision-Awareness**: Edits invalidate older approvals and stale evidence; assertions bind to commit SHAs.
*   **No Placeholders**: Return structured limitation codes (not success) if interaction/tool is missing.
*   **KISS**: Single-term terminology; minimize data tables and orchestration structures.

## Non-Goals (Out of Scope)

*   General VM/shell rental or general-purpose cloud computing.
*   Autonomous decision making (strategy belongs to the reasoning client).
*   Product-assurance logic, mission-governance, or CI runner replacement.
*   Unrestricted browser proxies or persistent workspace hosting.
*   Storing raw conversational transcripts.

## Planned Product Changes

1. **Repositioning**: Focus on *Bounded execution for coding agents*. MCP is treated as an interface, not identity.
2. **Extended Task Schema**: Add optional fields: `definitionOfDone`, `invariants`, `escalationTriggers`, `stopConditions`, `verificationCommands`, `allowedPaths`, `maxRiskThreshold`.
3. **Structured Assertions**: Migrate from free-text arrays to typed authority collections (*decision*, *assumption*, *fact*).
4. **Structured Task Closure**: Enforce terminal states with fields for `result`, `rootCause`, `verificationRefs`, `risks`, `limitations`.
5. **Successor Tasks**: Tasks link to predecessor IDs for retries/rollbacks; terminal history remains immutable.
6. **Parallax Bindings**: Optional fields for `missionId`, `runId`, `findingIds`, `verificationContractHash`.
7. **Context-Rich Approvals**: Display goals, non-goals, risk level, checks, and revision-bound diff.
8. **Mechanical Rails**: Hard validation for paths, commands, diff sizes, and dependency changes.
9. **Assertion Expiry**: Mark assertions stale when repository changes.
10. **Anomaly Detection**: Warnings for state thrashing, repeated check failures, missing workspaces, and stale evidence.
11. **Richer Evidence**: Add interaction traces, browser timelines, and DOM snapshots without turning into a test framework.

## Delivery Sequence

### Phase 1: Product Definition & Task Contract
*   Adopt bounded-execution positioning.
*   Extend task schema with optional boundaries and structured closure.

### Phase 2: Parallax-Bound Execution
*   Accept Parallax handoff references.
*   Bind evidence/checks to task and revision; return structured completion metrics.

### Phase 3: Enforcement & Continuity
*   Implement path and command rails.
*   Implement successor task links, assertion freshness, and anomaly warnings.

### Phase 4: Richer Evidence
*   Add functional/interaction capture shapes.
*   Optimize `forge_review` as the default container-free path.

## Success Criteria
*   Container-free execution of "look at this page" reviews.
*   Continuity of tasks across client session restarts.
*   Differentiated, verifiable statements (fact vs assumption) for fresh turns.
*   Explicit human approval bound to a specific commit SHA and diff.
*   Automatic invalidation of stale evidence on commit updates.
