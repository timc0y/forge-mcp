# Research: Forge History and Earned Tool-Design Lessons

**Date:** 2026-08-07
**Evidence base:** 230 Git commits, current source/docs/tests, and historical
files inspected with `git show`. Commit links point to the repository's primary
history.

## Product conclusion

Forge's history supports a precise product:

> Ordinary ChatGPT reads, judges, and authors bounded repository changes.
> Forge provides authorized GitHub access, eager remote durability, disposable
> execution, responsive visual evidence, stored deployment environments, and
> deferred human approval without requiring agent-style orchestration.

The product is neither a background coding agent nor a low-level remote computer.
It gives ordinary Chat enough reliable action to improve a design-direction
document, add a plan, change a small set of source files, run a check, inspect
responsive screenshots, deploy a configured environment, and submit the result.

The strongest historical invariant is:

> **A file change does not exist until its commit is on GitHub.**

Forge should commit edits eagerly—before reporting success. The executor is a
disposable validation cache and must never be the only holder of file work.

## Why the history is unusually strong evidence

Many commit messages record production incidents and observed ChatGPT behavior,
not just architectural preference. Commit
[`c5add00`](https://github.com/timc0y/forge-mcp/commit/c5add0069c1639342d8ddad04aced28d66fc193f)
states that production `mcp_tool_calls`, rather than the test suite, produced the
important findings and that confident deletion assumptions were disproved by
traffic. Conversation simulations are useful regression contracts, but they do
not substitute for real model-selection and turn-behavior tests.

## Chronology

### 1. Low-level remote computer

The validated foundation
([`b496f8c`](https://github.com/timc0y/forge-mcp/commit/b496f8c050814c43ad412df3d848860ff53c0b29))
exposed 13 workspace, file, Git, shell, process, preview, and screenshot tools.
The ChatGPT-native review expansion quickly grew this to repository, artifact,
Git branch/commit/push/PR, accessibility, and review operations.

The original interface required ChatGPT to assemble a control-plane sequence:

```text
workspace → files → branch → edit → command → preview → commit → push → PR
```

That sequence became the source of most later failure modes.

### 2. Evidence consolidation

The HeadteacherChat review
([`c6781ad`](https://github.com/timc0y/forge-mcp/commit/c6781ada4968986db972e773be220020254cac24))
improved checkout health, partial review evidence, artifact retrieval, and patch
diagnostics. Soon after,
[`e647447`](https://github.com/timc0y/forge-mcp/commit/e647447ff788cb176a6dc24832ed51696b1b2093)
collapsed five browser/evidence operations into two semantic review tools. This
was the first clear move from primitives toward deep user actions.

### 3. Persistence grew into public lifecycle

[`00c6140`](https://github.com/timc0y/forge-mcp/commit/00c6140ef70ad3b59bdd244c06950d1de8dd89ed)
added five durable task tools so work survived reconnects, context compression,
container sleep, and client reconnection. The need was real; exposing the
record-keeping operations added more state for ChatGPT to retain.

The history later separated the durable need from the public interface: tasks,
workspaces, and processes are useful implementation records, but repository and
branch are better conversational identities.

### 4. Ordinary Chat failures became explicit

Several commits describe the target client directly.

- [`c826bec`](https://github.com/timc0y/forge-mcp/commit/c826bec80a0b8ab5a8540043b969542e9e2e6ba8)
  says ordinary Chat will not reliably chain calls, poll, or wait. Public URL
  review gained bare-URL defaults, named breakpoints, a 45-second budget,
  partial success, and images attached to the initiating call.
- [`360a01e`](https://github.com/timc0y/forge-mcp/commit/360a01e35408c2de8ec7e9425ec9a9750aa9d9d2)
  moved workspace readiness waiting into Forge because create-then-poll required
  a human to nudge every turn.
- [`5377975`](https://github.com/timc0y/forge-mcp/commit/53779757207fc04e373d37ce4b760c115d0ba8cd)
  made workspace IDs optional after Chat lost them, created duplicate
  workspaces, consumed slots, and stranded actual work.
- [`eb03f10`](https://github.com/timc0y/forge-mcp/commit/eb03f101a46cc08f1c30c82c8712597c55f9f2d0)
  reduced active-app screenshots from four calls plus polling to one preview
  operation that detects/starts/waits/exposes/captures and returns the images.

These are implementation experiments of the exact intended product, not an
argument for background autonomy.

### 5. Tool explosion and KISS correction

The “ChatGPT work environment” expansion reached roughly 61–64 tools, including
tasks, handoff, checks, process lifecycle, credentials, secrets, workspace
recovery, deployment, and submission. One KISS pass
([`e07c272`](https://github.com/timc0y/forge-mcp/commit/e07c272348d0fc4c3610606147125083dcea771e))
cut it to 34 by removing and merging recovery/control-plane variants.

The pattern repeated: a subsystem failure produced a public recovery tool; the
larger surface then produced wrong selection, ordering, retry, and guidance
failures.

### 6. Remote-first editing was the architectural breakthrough

Production had reported real branches, SHAs, and diffs for changes that still
existed only inside temporary compute. A later reaper could erase the only copy.

[`ca0a99a`](https://github.com/timc0y/forge-mcp/commit/ca0a99a1135490c669f88f1210634b765b1ff971)
inverted the failure mode:

- `forge_edit` creates blobs, tree, commit, and a guarded GitHub ref update;
- the commit is on origin before the tool returns success;
- the executor checkout becomes a cache that can be recreated;
- a stale executor is recoverable, while local-only work is not;
- conflicting remote changes are refused rather than force-overwritten.

[`79bf6fc`](https://github.com/timc0y/forge-mcp/commit/79bf6fca4c02e711944f7d7bd9a22aed7046bbd1)
then removed 16 Git/file/recovery tools and collapsed durable writes into one
`forge_edit`. Its lasting rule is:

> “A tool it can see is a tool it will call.”

Git status, diff, branch, rebase, commit, push, sync, PR creation, and competing
file-write tools no longer needed to be model decisions.

### 7. Small edits became safe for Chat

[`6712ab8`](https://github.com/timc0y/forge-mcp/commit/6712ab8841786e0eb4971754ec1c20660b6a3a3e)
was prompted by a one-line edit to a 2,000-line file. Whole-file re-emission was
expensive and could silently truncate content. Fragment replacement now lets the
model send only `{old,new}` while Forge:

- reads the authoritative file server-side;
- refuses missing or ambiguous matches;
- applies the bounded fragment;
- commits the complete file;
- removes a separate read-before-edit round trip when safe.

This is the best-fitting primitive for design docs, plans, configuration, and
small source changes. Whole-file content should remain limited to new or truly
small files.

[`542c113`](https://github.com/timc0y/forge-mcp/commit/542c113)
moved file reads/listing to GitHub. Reading and editing therefore require no
executor at all.

### 8. Semantic addresses replaced opaque control-plane IDs

[`bd8d130`](https://github.com/timc0y/forge-mcp/commit/bd8d130153b49667ea6a78027c858e4ae46dc0ae)
records production loss of opaque workspace IDs, including a session that
opened three workspaces and made later calls ambiguous. Twenty-five tools moved
to one optional human-meaningful address:

```text
owner/repo#forge/branch
```

Internal IDs remain valuable for isolation and storage, but repository/branch
survives summarization and can be recovered by a person.

### 9. Shell became validation, not another persistence plane

Execution now synchronizes from the remote GitHub branch before running.
Subsequent KISS commits prohibited `git add`, `git commit`, redirections,
`sed -i`, and `tee` as ways to save repository changes. Durable mutation has
one path: remote-first edit.

This rule must remain absolute:

- a command may test, build, inspect, or deploy;
- command-created repository files are ephemeral unless deliberately recreated
  and committed through the GitHub edit path;
- deployment and screenshots must identify the GitHub commit they used;
- destroying compute must never threaten authored work.

### 10. Chat transport constraints became correctness constraints

[`9c78d0f`](https://github.com/timc0y/forge-mcp/commit/9c78d0f0a0cbdbb10fa7940af92d589c26c2ef53)
records a long command dying at the client near 60 seconds while continuing
remotely with no usable result. Commands exceeding a host-safe window moved to
managed execution and returned a handle plus “do not rerun.”

Other production-derived changes:

- [`675e2b8`](https://github.com/timc0y/forge-mcp/commit/675e2b8) returned the
  semantic answer from a command instead of a giant log;
- [`fbfec85`](https://github.com/timc0y/forge-mcp/commit/fbfec85d4577028a1cc669ada2c2fc2449b53c98)
  stripped ANSI noise, halved a real shell response, and made output paths valid
  inputs to later tools;
- [`00fff87`](https://github.com/timc0y/forge-mcp/commit/00fff8710ea6f860fb24a680c65d3f1b4e1b5d66)
  started storing bounded/redacted request and response payloads because status
  and duration alone could not explain failures;
- [`571d8b3`](https://github.com/timc0y/forge-mcp/commit/571d8b36f406ccd0b8ac919c013452ca7ba0be7f)
  detected repeated identical failures and added guidance-integrity checks after
  removed tools regressed into messages four times.

### 11. Approval had to outlive Chat

[`30800bc`](https://github.com/timc0y/forge-mcp/commit/30800bc82de5eee69683b69c1527dd99250c9132)
changed PR approval from a synchronous interruption to a deferred operation:

- stage durable commits on GitHub;
- queue the human decision;
- return a review URL immediately;
- allow the workspace and chat to end;
- complete the PR server-side after approval.

The earned principle is that submission must leave a complete durable receipt.
No later model turn should be required to redeem approval.

### 12. Deployment converged toward stored profiles

Deployment evolved from provider-specific tools through env-name inference,
alias mapping, account discovery, and finally approved profiles
([`31f9bf2`](https://github.com/timc0y/forge-mcp/commit/31f9bf28d6b5418000314b47a2a1f3157e191a1b)).

Two durable facts emerged:

1. Secret values belong in Forge's encrypted vault and must never be returned to
   or reconstructed by the model.
2. Deploy command, cwd, account, expected URL, environment-name mapping, and
   approval are durable repository/environment configuration—not per-chat
   reasoning work.

The current full workflow still exposes too much setup choreography. Ordinary
Chat should normally choose a saved environment/profile and deploy once.

### 13. Generic in-chat UI was tried and removed

A shape-aware MCP widget was added, narrowed to read-only/visual tools, disabled,
then deleted in
[`442a64b`](https://github.com/timc0y/forge-mcp/commit/442a64bf1a53735d3cb7fe13643a608ae05e5215).
It rendered as a large redundant panel. Cached metadata then required a
tombstone resource so already-open sessions did not hang.

Attached screenshots, concise conversational results, hosted galleries, and
hosted approval pages survived. Core correctness should not depend on a generic
workspace console widget.

## Catalog evolution

Approximate declared tool counts at useful points:

| Commit | Tools | Meaning |
|---|---:|---|
| `b496f8c` | 13 | Initial remote-computer primitives |
| `71137a4` | 23 | GitHub and review expansion |
| `e647447` | 22 | Evidence consolidation |
| `00c6140` | 27 | Durable tasks added |
| `b3ed8d4` | 61 | Peak lifecycle/recovery/work-environment expansion |
| `e07c272` | 34 | Major KISS collapse |
| pre-`79bf6fc` | 54 | Git/file/recovery regrowth |
| `79bf6fc` | 38 | Remote-first removal of Git plumbing |
| `a896ecd` | 42 | Later admin/PR/access expansion |
| committed `HEAD` | 45 | Deploy profiles and evidence maturity |
| current dirty tree | 47 | Includes uncommitted site-review work |

The catalog repeatedly regrew because internal subsystems were promoted to
public tools. Tool count is not neutral: it increases repeated context, wrong
selection, invalid transitions, stale guidance, and migration risk.

[`f560842`](https://github.com/timc0y/forge-mcp/commit/f5608423065d1e52126f191c71d28e214c96e15d)
measured 42,934 catalog bytes across 38 tools. Later,
[`a896ecd`](https://github.com/timc0y/forge-mcp/commit/a896ecdb8db0ea41bebec36992798724afb334ef)
measured the actual wire payload at 68,099 bytes; output schemas contributed
25,454 bytes and could turn a successful side effect into SDK error `-32602`,
prompting a duplicate retry. Catalog and result bytes are correctness concerns
for Chat, not aesthetic concerns.

## Earned invariants

### 1. Eager GitHub durability

- Every authored file mutation updates a guarded `forge/*` ref on GitHub before
  success returns.
- A multi-file conversational edit becomes one atomic remote commit.
- Subsequent refinements may create further small commits; review can squash.
- No successful response may describe an executor-only file as saved.
- Every edit receipt includes remote branch, commit SHA, and commit URL.
- Preview, command, deployment, and submission identify the remote SHA used.

### 2. GitHub is the repository truth plane

- Repository list, tree/search, and file content come from GitHub.
- No workspace is needed for reading or editing.
- Internal compute synchronizes from GitHub, never the reverse.
- A stale/lost executor is recoverable; a local-only edit is prohibited.

### 3. Semantic addressing

- Public identity is `owner/repo` plus an optional meaningful branch.
- Opaque task/workspace/process/operation identifiers are implementation or
  same-response recovery details, not required conversational memory.
- Ambiguity errors name human-readable candidates.

### 4. Small bounded editing

- Prefer unambiguous fragment replacement.
- Permit whole-file content for new/small files only.
- Keep chat-facing limits deliberately small (for example, about 10 files and
  100–200 KB total, subject to real evals).
- Refuse silent truncation, ambiguous matches, or force overwrites.

### 5. Execution is disposable

- Commands synchronize from the current remote commit.
- Shell is for inspection, checking, building, and deployment—not saving edits.
- Forge owns bootstrap/dependency state.
- Complete within a host-safe budget or return one durable continuation; never
  encourage restarting an operation whose outcome is unknown.
- Return the result/failure summary first; store large logs separately.

### 6. Visual evidence is a one-call result

- Screenshot a public URL without a workspace.
- Screenshot an active branch by auto-starting/reusing its preview.
- Accept `phone`, `tablet`, and `desktop`; default at least phone and desktop.
- Attach actual images in the initiating result.
- Provide a signed gallery for overflow or later human inspection.
- Return partial evidence before the client timeout and state limitations
  precisely.

### 7. Deployment uses saved environments

- Secret values are entered through a secure Forge surface, encrypted, and
  never model-visible.
- Chat sees environment/profile labels and variable names only.
- One deploy action selects repository/branch/environment and returns a verified
  URL plus commit-bound receipt.
- Provider account mapping, secret attachment, process waiting, and retries stay
  behind the interface.

### 8. Human approval is durable and asynchronous

- Submit once; return one exact hosted review URL.
- The human may approve later with no live chat/workspace.
- No model polling or second submission is needed.

### 9. Results are honest and terminally useful

Every result should state:

- what actually happened;
- whether GitHub durable state changed;
- the evidence/receipt;
- limitations;
- at most one viable public next action.

Never return a success envelope containing terminal failure, an identifier no
public tool accepts, a guessed cause, a hidden/removed tool name, or a retry
instruction for an operation that may already have landed.

## Rejected or reworked ideas

| Idea | Historical outcome | Lesson |
|---|---|---|
| Persistent executor snapshots/uncommitted filesystem | Added, later removed; current architecture makes compute ephemeral | Never make executor storage a durability boundary |
| Generic MCP workspace console widget | Added, narrowed, disabled, deleted, then tombstoned for cached clients | Plain results, attached images, galleries, and approval pages are more dependable |
| Five browser lifecycle/evidence tools | Collapsed into semantic review/preview operations | Screenshotting is a deep action, not a workflow |
| Git status/branch/commit/push/sync/PR choreography | Deleted after remote-first editing | Chat should edit; Forge should persist |
| Required idempotency keys | Models invented/reused them; later made optional/server-owned | Retry safety belongs primarily to Forge |
| Synchronous approval redemption | Replaced by deferred server-side completion | Approval cannot require the original chat to survive |
| Shell as a durable edit path | Later prohibited | One persistence path prevents split-brain |
| Artifact-per-screenshot retrieval | Failed non-agentic Chat; images moved inline | Evidence must arrive with the call that creates it |
| Four-tool deploy-profile setup in every chat | Safer configuration but still agent-shaped | Configure once; select and deploy conversationally |
| Public recovery/observer sprawl | Repeatedly followed tool explosions | Recovery state is internal unless the human can act on it |

## Current mismatches

### Full surface

The committed full interface still asks the model to reason about tasks,
workspaces, dependency installs, processes, operations, observers, artifacts,
secrets, profile planning, and administration. Current guidance describes a
10-plus-step coding loop. This contradicts the history's strongest reductions.

### Current compact experiment

The uncommitted 17-tool `/mcp/chat` catalog is a filtered agent catalog rather
than a redesigned conversational interface. It still exposes task/workspace/
process lifecycle, while omitting deploy/env configuration, repository file
listing, semantic task recovery, diff inspection, and some recovery paths named
by results. It also disables prompts on the compact endpoint.

### Plan flow

The documented plan flow calls task creation followed by context/read without
an executor, but context/read still require a workspace locator when none exists.
The user goal is valid; the public seam remains unnecessarily workspace-scoped.

### Command summaries

The adapter currently prefers `nextStep`, `message`, and `summary`, while modern
handlers commonly emit `next_step`. Many model-visible text summaries therefore
degrade to a generic “completed,” losing the concise steer ordinary Chat needs.

### Durable site review experiment

The uncommitted site-review/status tools add useful durable review state, but a
mandatory second status call would regress the one-call screenshot lesson. A
simple screenshot request must continue returning images directly; durable broad
review can be a separate optional behavior.

## Recommended ordinary-Chat interface

History supports a small set of deep repository actions:

1. **`forge_list_repositories`**
   - List/search all currently authorized repositories.
   - Reconcile installations and explain missing access precisely.

2. **`forge_read_repository`**
   - Read explicit paths or select a bounded set relevant to a goal.
   - Use GitHub directly; no task/workspace/executor prerequisite.

3. **`forge_edit_files`**
   - Create/reuse a guarded branch automatically.
   - Apply bounded fragment or small-file changes.
   - Eagerly commit the complete change to GitHub before returning.

4. **`forge_run_command`**
   - Materialize/synchronize compute internally.
   - Run one bounded inspection/check/build command.
   - Return a semantic result or one recoverable continuation.

5. **`forge_screenshot`**
   - Target a public URL or active repository branch.
   - Auto-start preview when required.
   - Return phone/desktop images inline, with optional tablet/custom breakpoints
     and gallery overflow.

6. **`forge_list_environments`**
   - Return safe deploy-profile/environment labels and variable names, never
     values.

7. **`forge_deploy`**
   - Deploy a remote commit using a saved approved environment/profile.
   - Return verified URL and commit-bound receipt.

8. **`forge_submit_review`**
   - Stage/submit the current remote branch for deferred human approval.
   - Return one exact review URL and require no polling.

One generic status/recovery action may be justified for operations that truly
outlive the host request. It should accept repository/branch or the immediately
returned handle; process/dependency/operation-specific status tools should not
be normal conversational vocabulary.

## Expected flows

```text
Improve a design-direction document
read_repository → edit_files
```

```text
Add a small plan
read_repository (only if context is needed) → edit_files
```

```text
Change a core file and verify it
read_repository → edit_files → run_command
```

```text
Iterate a visual change
read_repository → edit_files → screenshot
```

```text
Review any live website
screenshot
```

```text
Deploy the active change
list_environments (only if ambiguous) → deploy
```

```text
Submit the change
submit_review
```

Every call remains useful if ChatGPT stops immediately after it.

## Research-driven implementation priorities

1. Preserve and test eager remote-first editing before changing the catalog.
2. Design a new chat interface rather than filtering existing definitions.
3. Make reads/edits repository-scoped and workspace-free.
4. Collapse command bootstrap/wait/log mechanics behind one action.
5. Preserve one-call inline screenshots for both URL and branch targets.
6. Collapse deployment to saved environment selection plus deploy.
7. Keep deferred review submission and hosted approval.
8. Make public next actions transition-closed.
9. Test in real ordinary Chat, using production payload telemetry as the final
   authority.

## Bottom line

Forge's history did not mainly learn how to make an agent more autonomous. It
learned how to remove infrastructure reasoning from ordinary Chat while keeping
ChatGPT in charge of the small repository decision.

The lasting advances were:

- authoritative GitHub reads;
- eager GitHub commits;
- fragment edits;
- automatic remote branches;
- semantic repository/branch addressing;
- disposable execution synchronized from GitHub;
- host-safe commands;
- attached responsive screenshots;
- saved secret/deploy profiles;
- deferred human review;
- honest compact receipts.

That is the product to finish.
