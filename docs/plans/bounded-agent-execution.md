# Bounded execution for coding agents

## Purpose

Forge exists because giving a coding agent repository access is not the same as giving it a usable, safe, durable way to work.

Agents still waste time and context on setup, invent different workflows in every host, lose state when conversations end, and ask humans to approve actions without enough product context. Generic remote computers solve access while often making authority, provenance, cost, and continuity worse.

Forge should be the bounded execution layer for coding agents.

> Give ChatGPT, Codex, Claude, and other compatible clients a secure, durable place to inspect, run, change, and verify software.

Forge supplies execution and evidence. The client supplies reasoning. Parallax can supply the product contract and verification requirements, but Forge must remain useful without Parallax.

## The whole loop

```text
Product or engineering intent
    ↓
Durable Forge task
    ↓
Boundaries, decisions, non-goals, stop conditions
    ↓
Cheap repository context
    ↓
Ephemeral workspace only when needed
    ↓
Run, inspect, change, and check
    ↓
Human approval for consequential external action
    ↓
Evidence and terminal closure
    ↓
Resume, verify, or hand back to Parallax
```

## Problems Forge eliminates

### Agents struggle to see the actual application

Before useful product judgement, an agent may need to install browser tooling, start the app, expose a port, launch Chrome, choose viewports, capture screenshots, find the files, and repeat the process for every route.

Forge should compress this into semantic operations such as:

```text
forge_review(url, routes, states, viewports)
```

The result should return structured visual, viewport, accessibility, provenance, and limitation data rather than a transcript of browser setup.

### Operational setup consumes reasoning context

Logs, process IDs, browser flags, package installation output, port mappings, retries, and screenshot paths compete with the product or engineering problem for the model's finite attention.

Forge converts low-level operations into compact, structured outputs so agents can reason about the work instead of the machinery.

### Tool availability does not equal tool usability

A server can expose many tools while leaving the model to infer order, cost, risk, and authority.

Forge's tool surface should teach the intended operating model:

1. use container-free reads first;
2. start a durable task for coherent work;
3. create a workspace only when execution or mutation is needed;
4. inspect context before reading everything;
5. inspect outgoing risk before Git mutation;
6. request approval for consequential actions;
7. capture evidence honestly;
8. finish the task and destroy the workspace.

### Every host invents a different workflow

ChatGPT, Codex, and Claude have different local capabilities and session models. Without a common execution layer, the same request produces different setup, evidence, and safety behaviour.

Forge provides shared concepts:

- task;
- workspace;
- process;
- preview;
- evidence;
- artifact;
- capability;
- approval.

### Work disappears when the conversation ends

Context compression, reconnects, model changes, app restarts, and container sleep otherwise destroy the working memory of the task.

Forge tasks preserve the goal, decisions, non-goals, likely paths, files read and changed, checks, evidence, outstanding work, and next action independently of one conversation.

### Agent summaries mix facts, assumptions, and decisions

A handoff can say tests pass, the bug is reproduced, or only mobile is affected without saying whether those claims are current, verified, inferred, or stale.

Forge should distinguish:

- binding decision;
- verified fact;
- observed fact;
- inference;
- assumption;
- advisory recommendation;
- contradicted or stale assertion.

### Agent autonomy widens unpredictably

A small task can expand into dependency upgrades, route changes, authentication work, infrastructure changes, or unrelated cleanup because adjacency is mistaken for authority.

Forge tasks should carry explicit goals, non-goals, hard invariants, allowed and forbidden areas, escalation triggers, definition of done, and stop conditions.

### Remote execution usually grants too much power

A generic remote computer may expose unrestricted shell, network, credentials, persistence, and Git mutation.

Forge should prefer:

- authorised repositories;
- tenant isolation;
- ephemeral workspaces;
- scoped capabilities;
- command classification;
- approval for destructive, unrestricted-network, and external-write actions;
- revision-aware mutation;
- evidence and auditability;
- reliable cleanup.

### Human approval lacks enough context

“Approve push” is not meaningful consent when the reviewer cannot see the task, source problem, boundaries, risk, checks, outstanding verification, and exact diff.

Forge approval should evolve from diff acceptance toward informed approval of a bounded change.

### A code change is mistaken for a completed task

Agents often declare success after editing or passing tests, even when the original product problem was not retested.

Forge should support structured closure containing result, root cause, checks, evidence, limitations, remaining risks, and next action.

### Evidence is detached from the revision it represents

Screenshots and logs can come from the wrong branch, old preview, earlier workspace revision, or unrelated deployment.

Forge evidence should bind to repository, commit, branch, workspace, workspace revision, route, state, dimensions, time, and artifact hash where applicable.

### Repeated failures do not become learning

When each attempt is trapped in a different session, agents retry the same assumption with superficial variations.

Forge should preserve predecessor relationships, terminal root causes, assertions, and evidence so a later task can recognise a failed strategy rather than merely a failed patch.

### Costly work begins too early

Agents frequently start containers, install dependencies, and read large trees before establishing whether cheap metadata or a deployed URL is sufficient.

Forge should continue to make the cheapest correct path the easiest path.

## Core use cases

### Snapshot a deployed application

Capture decisive routes and states at bounded viewports with structured screenshot and accessibility evidence, without creating a workspace.

### Continue work across hosts

Start a task in ChatGPT, inspect or modify it in Claude, and verify or approve it elsewhere without replaying the original conversation.

### Remote repository inspection

Select likely context, inspect files, search tasks, and understand an outgoing diff before creating expensive compute or reading the entire repository.

### Isolated coding task

Create a lightweight workspace session for an authorised GitHub branch, edit durably through `forge_edit`, allocate an ephemeral executor only to run commands and checks or preview the app, and preserve task state outside that executor.

### Product-finding implementation

Receive a Parallax finding with audience, mission, observed consequence, decisions, non-goals, required evidence, and verification boundary; execute without losing that reasoning.

### Human-approved Git mutation

Prepare a revision-bound diff and provide a signed, tightly scoped approval link showing task context and exact proposed change before push or pull request creation.

### Durable handoff

Allow a fresh model to retrieve a compact summary that clearly separates completed work, verified facts, assumptions, outstanding work, and next recommended action.

### Safe failure

Finish a task as failed or cancelled while preserving root cause, partial evidence, invalid assumptions, and a useful successor recommendation.

### Self-hosted execution

Use Forge's control and task model while running compute on an operator-controlled host where required.

### Evidence provider

Supply Parallax or another consumer with versioned, provenance-bound visual, functional, runtime, and accessibility evidence.

## Operating principles

### Semantic tools over shell rituals

Where an operation is common, consequential, and structurally understood, prefer a focused tool that returns compact typed output over repeated ad hoc shell commands.

### Cheap first

Use task, repository, context, diff metadata, and deployed-URL review tools before creating a workspace.

### Durable task, disposable workspace

The task is the continuity record. The workspace is temporary compute. Never make the container the only holder of important state.

### Bounded authority

Autonomy is the authority explicitly granted by the task and platform, not everything technically reachable from the workspace.

### Human approval at real risk boundaries

Do not require approval for every harmless read. Do require it for destructive, unrestricted-network, credential-sensitive, production, or external-write actions.

### Revision-aware actions

Checks, evidence, approvals, and mutations must identify the revision they apply to. A later edit invalidates earlier approval where the protected diff changed.

### Evidence before completion

A task should not be complete merely because files changed. Completion should reflect declared checks and evidence requirements.

### Honest limitations

Return structured limitations and partial states rather than pretending a missing browser, auth state, or interaction was exercised.

### One word per concept

Keep task, workspace, process, preview, evidence, artifact, capability, and approval distinct in schemas, UI, tools, and docs.

### KISS over framework accumulation

Do not create a new tool, state machine, database table, or governance object when an additive field or existing workflow solves the problem.

## What Forge should not become

### Not a general cloud computer product

Forge is an agent execution control layer, not a generic VM, shell rental, or browser automation service.

### Not a replacement for the coding model

Forge does not decide product strategy or implementation by itself. It supplies controlled capabilities and durable state to a reasoning client.

### Not a product-assurance system

Forge can capture evidence and carry Parallax references. Parallax owns audience, mission, product truth, evidence sufficiency, findings, and verification semantics.

### Not a second mission framework

Do not copy Parallax missions or SPAWN governance into Forge. Extend the durable task model with only the execution boundaries it needs.

### Not a CI replacement

Forge may run checks and report results, but CI remains the repository's independent merge and release gate.

### Not an autonomous DevOps platform

Avoid broad production deployment, infrastructure mutation, secret management, or permanent environment orchestration unless introduced as narrowly scoped, independently secured products.

### Not an unrestricted browser or network proxy

Maintain public-host validation, network policy, capability scope, request allowlists, and tenant isolation.

### Not a permanent workspace host

Persistence belongs in task records, Git, and artifacts. Workspaces should remain disposable.

### Not a transcript archive

Store compact structured task state, not entire private model conversations or unnecessary command history.

### Not approval theatre

Do not add approval clicks to low-risk actions merely to appear safe. Place approvals where they materially constrain authority.

### Not a tool-count competition

Prefer improving schemas, descriptions, next steps, and composition over adding overlapping tools.

### Not an orchestration monster

Do not build a generic multi-agent scheduler, role hierarchy, meeting cadence, or autonomous programme framework without a concrete execution problem.

### Not an evidence claim inflater

A screenshot is not a journey, a build is not user success, and a command exit code is not proof of product correctness.

## Planned product changes

### 1. Reposition Forge

Keep the Forge name and drop “MCP” from product-facing positioning where possible.

Proposed category:

> Bounded execution for coding agents.

MCP remains an interface, not the product identity.

### 2. Expand task grants

Add optional task fields for:

- definition of done;
- hard invariants;
- escalation triggers;
- stop conditions;
- verification commands;
- allowed and forbidden path prefixes;
- optional maximum risk or diff thresholds.

Do not make every field mandatory.

### 3. Separate decisions, assumptions, and assertions

Replace ambiguous free-text inheritance with structured authority and verification status; migrate current arrays to the new shapes rather than dual-reading both.

### 4. Structured terminal closure

Extend task completion with result, root cause, verification references, remaining risks, limitations, and next action.

### 5. Successor relationships

Allow a new task to reference a predecessor as follow-up, retry-after-invalid-evidence, regression, supersession, rollback, or assumption test. Do not reopen terminal history when the identity of the work changed.

### 6. Bind tasks to Parallax contracts

Add optional references for mission, source run, finding IDs, decision IDs, required evidence, and verification contract hash. Forge remains provider-neutral and usable without these fields.

### 7. Context-rich approvals

Show task goal, source finding, binding decisions, non-goals, risk, checks, evidence status, outstanding verification, and exact revision-bound diff.

### 8. Mechanical rail enforcement

Enforce only stable technical boundaries such as path scope, command class, production-write prohibition, dependency-change escalation, diff-size threshold, and required checks before external mutation.

Do not attempt to mechanically enforce subjective goals such as “improve usability”.

### 9. Assertion freshness

Bind verified assertions to workspace revision, commit, evidence, and time. Mark assertions stale after relevant mutation.

### 10. Task anomaly warnings

Warn when:

- state changes repeatedly without deliverable movement;
- the same check fails after materially similar patches;
- the workspace is gone while the task remains active;
- completion retains outstanding work;
- evidence belongs to an older revision;
- an approval no longer matches the current diff;
- likely paths widen repeatedly;
- only process machinery changed for a product task.

Start as warnings, not blockers.

### 11. Richer semantic evidence

Investigate interaction traces, browser timelines, DOM or accessibility snapshots, and functional step evidence without turning Forge into a full browser-testing framework.

## Delivery sequence

### Phase 1: product definition and task contract

- adopt bounded-execution positioning;
- document the agent product loop;
- define shared IDs and authority vocabulary with Parallax;
- extend tasks with optional boundaries and structured closure.

### Phase 2: Parallax-bound execution

- accept optional Parallax handoff references;
- include contract context in task summaries and approvals;
- bind evidence and checks to task and revision;
- return structured completion for Parallax verification.

### Phase 3: enforcement and continuity

- add selected path and action rails;
- add successor relationships;
- add assertion status and freshness;
- add anomaly warnings.

### Phase 4: richer evidence with strict scope

- add functional and interaction evidence shapes where real consumers require them;
- preserve cheap `forge_review` as the default deployed-URL path;
- avoid a broad browser-automation platform.

## Success criteria

Forge is succeeding when:

- “look at this page” is one semantic call rather than a browser-setup project;
- agents spend less context on operations and more on reasoning;
- a coherent task survives model, host, session, and workspace changes;
- a fresh agent knows which inherited statements are binding, verified, assumed, or stale;
- agents cannot silently widen consequential scope;
- humans approve a bounded intent and exact revision, not a context-free command;
- evidence can be traced to the code and runtime state it represents;
- failed tasks leave useful learning rather than dead transcripts;
- cheap read paths prevent unnecessary containers and cost;
- Forge remains understandable despite gaining capability.

## Open questions

- Which task boundaries should be advisory versus technically enforced?
- How should existing `decisions` and `non_goals` migrate to richer structures?
- Which assertion statuses are necessary without burdening agents?
- What context belongs on an approval page without overwhelming the reviewer?
- Which Parallax schemas should be referenced directly versus copied into a neutral interchange shape?
- When should evidence automatically become stale after mutation?
- Which anomaly warnings are useful enough to justify persistent state?
- How far can semantic browser evidence go before Forge becomes a testing framework?
