# Agent execution playbook

Forge is a GitHub-native coding control plane with optional ephemeral execution, not the place where an agent should perform all of its thinking. The cheapest and most reliable pattern is to make the product decision first, use GitHub-backed tools for repository work, and allocate the executor only for commands, installs, builds, tests, dev servers, previews, or deploys.

For ChatGPT-ready recipes (plan, UI iteration, bug fix, resume), see
[project-workflows.md](./project-workflows.md).

## Core operating model

Separate every task into two layers.

### High-level layer: decide before creating a workspace

The coordinating agent owns:

- the user outcome and acceptance criteria;
- the architectural boundary and non-goals;
- the smallest coherent change that can prove the approach;
- the files or subsystems likely to be relevant;
- which checks and browser journeys are required;
- whether Forge is needed at all.

Do this with repository search, existing documentation, issue or PR context, and deployed-site review. Do not open a container merely to think broadly, summarise documentation or inspect a public URL.

### Low-level layer: operate through Forge

Forge owns two deliberately separate kinds of work:

- read a bounded GitHub repository tree and targeted file ranges;
- commit several related file edits atomically with `forge_edit`;
- install only the dependencies needed for the task;
- run the smallest useful checks first;
- start a development server only when runtime verification is required;
- capture bounded browser and accessibility evidence;
- inspect GitHub diff metadata and commit history;
- open a draft PR through the approval flow;
- destroy the workspace when no later execution command needs its ephemeral state.

Repository reads, edits, diffs, commits, branches, history, and pull requests use the GitHub API and do not allocate an executor. Executor filesystem changes are disposable and never become GitHub edits unless the agent explicitly recreates them with `forge_edit`.

## Cost ladder

Use the lowest rung that can prove the claim.

| Cost | Path | Use it for |
| --- | --- | --- |
| Lowest | No Forge call | reasoning, planning, public documentation, connector-native repository reads |
| Very low | `forge_review` | screenshots and accessibility evidence for an already deployed URL; no container |
| Low | GitHub-backed workspace session | file-tree inspection, targeted reads, documentation edits, and `forge_edit` commits; no executor |
| Medium | Ephemeral executor | type-checking, unit tests, builds and dependency-aware runtime checks |
| Higher | Running process and private preview | route, state and responsive verification that cannot be proven statically |
| Highest | Broad installs, full builds, many browser captures or long-lived workspaces | only when a release-level claim genuinely requires them |

Never jump to a higher rung because it is more complete in theory. Move upward only when the previous rung cannot verify an acceptance criterion.

## Context envelope

The agent should construct a small task packet before calling Forge.

```text
Outcome
One sentence describing what becomes true for the user.

Current state
Only the facts needed to explain the gap.

Decision
The chosen architecture or implementation direction.

Scope
The smallest coherent set of changes.

Non-goals
Adjacent work that must not be pulled into the task.

Likely files
A bounded list of paths or subsystems to inspect first.

Acceptance criteria
Observable behaviour, commands and journeys that prove completion.

Risk notes
Security, data, migrations, production access or irreversible actions.
```

Keep this packet under roughly one screen where possible. Link to canonical plans rather than pasting them. The low-level agent should retrieve exact sections on demand.

## Repository-reading strategy

1. Read repository-level instructions first.
2. Request a shallow tree, normally depth 2–4, rooted at the relevant package or application rather than the repository root.
3. Read entry points, package manifests and existing tests before implementation files.
4. Use bounded line ranges and raise `max_bytes` only when the first read proves it necessary.
5. Follow imports one hop at a time. Do not recursively load an entire subsystem into context.
6. Summarise discovered contracts in a short scratch note before patching.
7. Stop reading when the implementation boundary and tests are understood.

A useful default context budget for one implementation pass is:

- one task packet;
- one shallow file tree;
- 3–8 targeted source files;
- 1–3 relevant test files;
- the current diff;
- bounded command output.

If substantially more is required, split the task or create a discovery-only pass before implementation.

## Workspace strategy

### Reuse one control-plane workspace per repository task

Do not create separate workspace sessions for reading, editing, testing, and review. Reuse the same `workspace_id` so repository authorization, branch selection, processes, and previews remain coherent. GitHub remains authoritative even while an executor exists.

### Choose bootstrap deliberately

Use repository tools without waking the executor when the first pass only needs:

- a file tree;
- file reads;
- documentation or configuration edits through `forge_edit`;
- a decision about which package must be installed or tested.

The `bootstrap` setting is applied only if an execution tool later allocates the executor. Enable it when project detection and dependency setup will be required; do not pay for execution merely to inspect or edit a repository.

### Destroy aggressively

Destroy the workspace once:

- wanted changes are committed and verified on GitHub through `forge_edit`;
- the final GitHub diff and evidence are captured;
- no follow-up command depends on local state.

Preserve artifacts when review evidence matters. A sleeping workspace is cheaper than an active one, but a destroyed workspace is the correct default after task completion and frees scarce capacity.

## Editing strategy

- Prefer one coherent `forge_edit` call over many single-line edits.
- Edit the implementation and its tests together.
- Re-read paths after a conflict; GitHub blob and branch-tip guards prevent stale overwrites.
- Use stable idempotency keys derived from task and operation, not random retries.
- Inspect `forge_diff_metadata` after each meaningful edit, not after every tiny change.
- Keep unrelated formatting or cleanup out of the diff.
- Split a large programme into independently shippable PRs rather than one long-running workspace.

Commands may create or modify executor files, but those changes remain executor-only and report `remote_persisted:false`. Recreate only deliberate repository changes with `forge_edit`; Forge never imports an executor filesystem into GitHub.

## Command strategy

Run checks from narrow to broad:

1. syntax or targeted type check;
2. affected unit test or package test;
3. affected application check;
4. production build only when the change crosses build or deployment boundaries;
5. full repository verification only at integration or release gates.

Use bounded output and targeted reruns. Do not rerun a successful full suite after a documentation-only adjustment. Do not install dependencies twice in the same workspace. Avoid unrestricted network access unless the exact command requires it and the approval is justified.

## Browser strategy

Browser evidence is for behaviour that source and tests cannot prove.

- For an existing URL, use `forge_review` before considering a workspace.
- For local changes, start one server, expose one private preview and reuse it.
- Capture only the routes, states and viewports named in the acceptance criteria.
- Start with phone and desktop. Add more viewports only when a breakpoint-specific issue exists.
- Prefer one bounded `forge_review` or `forge_preview` packet over many ad-hoc screenshots.
- Inspect each screenshot used in a conclusion and pair it with the accessibility tree when interaction, labels or order matter.
- Never claim a journey passed from static screenshots alone; execute the interaction or state clearly that it remains unverified.

## Recommended coding sequence

```text
1. Decide outcome and architecture outside Forge.
2. Create a forge/ branch on GitHub with forge_start.
3. Create one lightweight workspace session on that branch.
4. Read instructions and a shallow targeted tree from GitHub.
5. Read the minimum source and test files from GitHub.
6. Commit one coherent implementation-and-tests edit with forge_edit.
7. Run the smallest relevant checks.
8. Expand checks only when risk or failures require it.
9. Start a preview only for behavioural acceptance criteria.
10. Capture bounded evidence.
11. Inspect GitHub diff metadata and history.
12. Open a draft PR through forge_merge and approval.
13. Destroy the workspace.
```

## Example: headless cart task

High-level packet:

```text
Outcome
A customer can add a Shopify variant on headteacherchat.com, edit a persistent basket and continue to Shopify-hosted checkout.

Decision
Keep Astro and Shopify. Add Storefront Cart API mutations and first-party cart UI. Do not migrate to Hydrogen or rebuild payment checkout.

Scope
Typed cart client, cart cookie, add/update/remove APIs, header count, drawer, /cart, checkoutUrl and tests.

Non-goals
Membership discounts, Shopify B2B, redesigning product pages, placing a real production order.

Acceptance
Cart survives refresh; quantities update; unavailable lines recover clearly; checkoutUrl opens; phone and desktop drawer pass keyboard and accessibility checks.
```

Forge then performs only the bounded repository work. It should not re-litigate the platform decision unless the code reveals a concrete contradiction.

## Anti-patterns

Avoid:

- creating a workspace before deciding what success means;
- asking the workspace to “review the whole repo and decide what to build”;
- loading every plan, audit and source file into model context;
- running `pnpm install`, the full test suite and a production build before inspecting the package boundary;
- starting multiple development servers for the same task;
- capturing every route at every viewport;
- leaving workspaces alive after review when no later command needs the executor;
- using Forge for a docs-only GitHub edit when the repository connector can make it safely;
- turning one feature into a broad refactor because the workspace makes it possible.

## Product-level opportunities

Forge itself should reinforce this operating model over time:

- expose estimated cost class and container usage in tool results;
- warn when a new workspace is requested while an existing workspace for the repository is active;
- support explicit discovery-only workspaces with no bootstrap;
- report active workspace age and idle state;
- provide a workspace-list and bulk-cleanup action;
- allow a client to attach a compact task packet to workspace metadata;
- return suggested next cheapest action after each tool result;
- add targeted project checks generated from changed paths;
- summarise large command output into durable artifacts rather than returning it repeatedly to model context;
- re-materialize disposable executors from the current GitHub branch when their checkout is lost.

## Completion standard

A Forge task is complete when the requested outcome is implemented or disproved, the smallest necessary checks have passed, behavioural evidence exists where needed, the outgoing diff is understood, durable Git state exists, and the workspace has been destroyed.
