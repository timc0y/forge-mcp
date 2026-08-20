# Forge V1

**Status**: Proposed. Supersedes the executor-era architecture and the archived
[cost controls](./cost-controls.md) proposal.

## Thesis

Forge is hands and eyes for a mind that can only talk, and it owns nothing that
runs.

## Five tools

None takes a mode, an action, or an identifier the chat must remember. A mode is
a tool the model has to choose, wearing a disguise.

| Tool | What it does | Gate |
|---|---|---|
| `forge_read` | no repo → your repos. repo → tree and open changes. repo + change → what that change did. add paths → file contents, or the patch for those paths. | free |
| `forge_edit` | write files. Creates the repo if it is new. Creates the change from the intent. Never touches the default branch. | free |
| `forge_merge` | land a change on `main` | **approved** |
| `forge_discard` | throw a change away | **approved** |
| `forge_see` | screenshot a public URL | free, quota'd |

`forge_read` is one question — *show me what's there* — asked at four zoom
levels. **Reading a change is the diff**; there is no separate diff tool and no
depth parameter, because asking about paths is what asking for a patch already
looks like.

`forge_merge` and `forge_discard` stay apart rather than becoming one tool with
an action. They are the two acts a human is asked to authorize, and an approval
card must never be ambiguous about which one it is.

### The two rules that keep it small

**Nothing is created by ceremony.** Write to a repo that does not exist and it is
created. Write with a new intent and a change is created, on a branch named by a
deterministic slug of that intent. The model never names a ref and never asks for
a repo to be made.

Guard: Forge refuses to create a repo whose name is within a character or two of
one you already have, and names the candidate instead — the same
name-the-candidates rule that fixed workspace ambiguity in `bd8d130`.

**Every receipt carries the state.** Each response lists the repo's open changes.
That is what replaces client memory: the next turn continues by name because the
last turn said the names.

## What V1 does not have

Containers, shell, builds, tests, deploys, previews, hosting, asset upload —
and also: no site crawl, no multi-route review, no gallery, no artifact
retrieval, no arbitrary ref comparison, no capture cache.

`forge_see` takes one URL and returns the images inline with the call that asked
for them. That single decision removes the Workflow, the artifact store, the
gallery pages, and the signed-URL retrieval path — and it honours the earned rule
that evidence must arrive with the call that created it, rather than as an ID to
fetch later.

## Runtime

| Binding | Now | V1 |
|---|---|---|
| `MCP_SESSIONS` (DO) | yes | kept — MCP transport |
| `Sandbox`, `WORKSPACE_COORDINATORS` (DO) | yes | **removed** |
| All four Workflows | yes | **removed** |
| R2 | yes | **removed** — images return inline |
| Workers AI | yes | **removed** — nothing to plan |
| D1 | yes | kept — identity, approvals, invites, quota |
| Browser Rendering | yes | kept |

One Durable Object. No Workflows. No object storage. Two moving parts and a
database.

## Build it by subtracting

The valuable code already exists and is battle-tested: OAuth and the GitHub App,
the blob→tree→commit path in `github.ts` with its earned conflict semantics
(`ca0a99a`), and the MCP transport. The executor plane is separable from all of
it, and the audit showed 48 of 55 handlers are already unreachable.

So V1 is reached by deletion, not rewriting. Rewriting would throw away the
conflict rules and the auth, which are the two things you least want to write
twice.

### Phase 1 — Subtract

Delete the execution plane: sandbox, workspace coordinator, capacity, deferred
actions, all four Workflows, preview, deploy profiles, shell. Delete the
mitigations that existed only to survive it: workspace-id resolution,
single-open disambiguation, `fastForwardToRemote`, shell write prohibitions, the
45 s escalation path, repeat-call detection.

Sweep the audit's confirmed dead code in the same pass: `readableFile`,
`assertCleanForMerge`, `diffTotals`, the diff-paging pipeline, `EventPublisher`,
`ForgeMcpAdapter`, the unreachable `'privileged'` command class, the eight unread
feature flags, and the "47 MCP tools" claim in `docs/README.md`.

*Proof*: `pnpm check`. Bindings reduced as tabled. No route, tool, or guidance
string references a removed symbol — the lint from `571d8b3` enforces the last
part.

### Phase 2 — Reshape

Five tools. Change-by-intent naming. Repo creation on first write, with the
near-name guard. Open-changes list in every receipt. Capture switched from
Puppeteer to the `/snapshot` Quick Action, images inline.

This republishes the catalog, so it is a release with a rollback plan, not an
edit.

*Proof*: `pnpm check`; `pnpm schemas:check`; catalog budget test green and
materially smaller; tool count asserted so the surface cannot quietly regrow.
Then the real one — from a phone: an idea becomes a repo with documents in it, a
change is made and read back, a page is captured, the change is merged. An
identifier is deliberately dropped mid-conversation to prove recovery by name.

### Phase 3 — Open it

Two things, not a subsystem: **an invite table** and **a daily capture counter**.

Nothing else. No cache, no lifecycle rules, no cost package, no usage tiers. The
other four tools stay unlimited because they cost Forge nothing.

*Proof*: two accounts proven unable to reach each other's repositories or
captures; quota refusal observed at the boundary, naming the limit and the reset
time; measured mean capture duration replacing the assumption below.

## Cost

Only one action spends Forge's money.

**GitHub work costs nothing.** Each user installs the GitHub App themselves, so
every read, commit and merge is metered against their own installation limit
(~5,000/hr). Repository usage scales with users at zero marginal cost.

**Capture is the only meter.** Workers Paid includes 10 browser hours/month, then
$0.09/hr. Quick Actions like `/snapshot` are billed on browser hours **only**;
Puppeteer sessions are billed on hours *and* concurrent browsers ($2 per browser
over 10). Using the REST snapshot removes an entire billing dimension.

At an assumed ~5 s per capture, the included 10 hours is ~7,200 captures/month.
Fifty users at 30 captures/day is ~62 browser hours ≈ **$4.73/month in total** —
not per user.

> **Assumption to measure in Phase 3**: mean capture duration. Everything above
> scales linearly with it.

The archived cost-controls plan targeted ~$10/month *per user* and proposed a
`@forge/cost` package metering active time, idle time, browser duration,
dependency installs, builds, command counts and artifact storage. Deleting the
executor deletes six of those seven meters. What remains is one integer per user
per day.

## Risks

- **Tenancy is load-bearing again.** The audit found `tenantId`/`projectId`
  threaded through 613 references and always set to one constant, and recommended
  collapsing them. Multi-user preview reverses that. Keep them; the isolation
  test in Phase 3 is what proves they work.
- **Repo creation by writing** is the one place the "no ceremony" rule touches
  something irreversible. The near-name guard is the whole mitigation, so it
  needs a test of its own.
- **Catalog snapshots are frozen** until re-scanned, so getting the five right
  matters more than usual.
- **GitHub is a single point of failure.** Accepted deliberately, in exchange for
  never having a second copy that can diverge.
- **Capture has a real clock** — 60 s at Cloudflare, and the chat client cuts near
  the same point. Partial evidence with stated limitations is mandatory.
- **`forge_see` makes Forge an HTTP client aimed at user-supplied URLs.**
  Public-host enforcement, the quota, and invite-only membership are the three
  things holding that closed.

## Open questions

- Mean capture duration, which sets the quota.
- Whether preview users may create repositories, or only work in ones they own.
- Whether Parallax ships with V1 or after — findings are ordinary repository
  files either way, so nothing in this plan changes if it waits.
