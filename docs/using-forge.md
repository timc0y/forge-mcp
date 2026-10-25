# Using Forge

Read your project and save useful work from your conversation.

Forge connects a conversation to a repository. It turns
research, visual reviews and small edits into durable commits and draft pull
requests. It does not run your code, and GitHub remains the only copy.

Start with one of three jobs:

- Save a plan, decision or brief in the repository where the next coding session
  can use it.
- Capture a public page at phone and desktop, then record the findings or make a
  small correction.
- Commit routine work directly, or explicitly hold a proposed edit for review
  on the fixed `forge` branch.

Run your own copy from the [MIT-licensed source](../LICENSE) using the
[self-hosting guide](./self-hosting.md). You supply your own GitHub App,
Cloudflare resources and credentials, pay your providers and supply your client
plan.

Use the [release checklist](./going-live.md) when setting up or updating.

---

## The words Forge uses

Forge works with repositories, changes and captures.

**Repository** — yours, on GitHub. Forge never keeps a copy. If Forge vanished
tomorrow your repositories would look completely normal, because everything it
did was an ordinary commit.

**Change** — work held for review. Forge uses one fixed `forge` branch and one
draft pull request. Each new proposed edit continues it. A repository cannot
have two active Forge changes.

**Capture** — a screenshot of a page that is already public, returned inline with
the tool call.

## How changes work

**A commit is durable the moment a tool returns.** There is no push step, no
staging area, no "unsaved" state. If `forge_edit` reports success, the commit is
on GitHub with a SHA and a URL you can open. Forge has no runner of its own, but
normal repository automation (for example GitHub Actions triggered by a push)
may react to that commit just as it would to any other GitHub write.

**Routine work becomes repository truth immediately.** Plans, research,
direction and routine content go to the default branch. Work that needs review
goes to the Forge change and needs your approval before it lands.

**Two things need Forge approval: merging and discarding.** Authorised routine
writes can commit directly to the default branch; your client may ask separately
for write permission. Merging lands a held proposal, and discarding destroys it.
Both send you one link showing exactly what would land, or how many commits would stop being reachable. The link keeps working after the
conversation ends, so you can decide later, from any device.

**Create a repository as you work.** With the required App permission, writing
to a repository that does not exist creates it. Ask to hold work for review and Forge creates the one change.
You do not make a repository, name a branch, or open a pull request first.

---

## Getting connected

First [set up your own instance](./self-hosting.md), then use its server URL and
GitHub App installation link: `https://github.com/apps/<YOUR_APP_SLUG>/installations/new`.
`<FORGE_PUBLIC_ORIGIN>` below means your configured instance URL, including any
path prefix.

The operator must include your GitHub login in `FORGE_ALLOWED_LOGINS`, a
comma-separated, case-insensitive list. Missing, blank or any malformed entry
denies everyone; wildcards are not accepted. App installation alone does not
grant service access. Capture also needs your login in the separate
`FORGE_CAPTURE_ALLOWED_LOGINS` consent list, which cannot grant service access.

Choose a client and plan that supports remote MCP connections and the actions
you want to use.

### 1. Add the server to your client

```
<FORGE_PUBLIC_ORIGIN>/mcp
```

**ChatGPT** — Settings → Apps → Advanced settings → Developer mode, then add
a custom app with that URL.

**Claude** — Settings → Connectors → Add custom connector. Or from Claude Code:

```sh
claude mcp add --transport http --scope user forge https://YOUR_FORGE_HOST/mcp
```

Replace `https://YOUR_FORGE_HOST` with your full `FORGE_PUBLIC_ORIGIN`, retaining
any path prefix. Use your configured origin followed by `/mcp`.

**Cursor agents** — add that URL as a remote HTTP MCP server. Its documented
HTTPS callback is admitted. See [Cursor’s MCP guide](https://cursor.com/docs/mcp).

**Grok Bot** — use a remote HTTPS MCP connector with per-person OAuth, as
[described by xAI](https://docs.x.ai/grok-bot/team-bots).

After a tool update, refresh the connection and start a new conversation.
See the [release checklist](./going-live.md).

### 2. Authorize

Your client opens a Forge page telling you what it is about to be allowed to do.
Continue from there and GitHub asks whether to let Forge act as you.

Forge holds one GitHub user credential encrypted at rest. All repository work,
approvals, repository creation and explicit public GitHub search use that
credential. GitHub enforces both your permissions and the App's installed
repository access, so Forge cannot borrow broader organisation permissions.

### 3. Install the GitHub App

Authorizing tells Forge **who you are**. Installing tells it **which
repositories it may touch**. They are deliberately separate.

```
https://github.com/apps/YOUR_GITHUB_APP_SLUG/installations/new
```

Replace `YOUR_GITHUB_APP_SLUG` with your own App's slug, or follow the link in
your instance's connection panel. Tim's private App is for his deployment.

Choose all your repositories or only some. Change it whenever you like, from
GitHub, without involving Forge. Repositories Forge creates for you are
reachable automatically — that is GitHub's own behaviour for apps.

Until you install it, tools will tell you so and give you this link.

### 4. Say what you want

> "Research our caching options and save the decision in docs/decisions."
>
> "Screenshot the homepage on phone and desktop, then write the visual review into the site repo."
>
> "Tighten the homepage copy and put it on a draft change."
>
> "What's changed in the pricing section?"
>
> "Merge it."

---

## The five tools

| Tool | What it does | Needs you |
|---|---|---|
| `forge_read` | Immutable repository source/evidence: repos, diffs, exact selectors, checks, analysis, public discovery and task-shaped context | no |
| `forge_edit` | Writes files directly, or on the one Forge change when the work needs review | no |
| `forge_merge` | Returns one link for you to land a change | **yes** |
| `forge_discard` | Returns one link for you to throw a change away | **yes** |
| `forge_see` | Screenshots a public URL and returns the images inline | no |

### forge_read

Reading a change **is** the diff — there is no separate diff tool, because
"what does this change contain" and "show me the diff" are the same question.
Ask about specific paths inside a change and you get their patches.

A normal repository read resolves one commit and reports that SHA. `change`
reads the proposal diff; `at="proposal"` reads the proposal's actual source.
Exact selectors include `path::symbol:Name`, `path::id:ID`, JSON pointers and
line ranges, and stay exact even when a question is supplied.

For a large file, pass `paths: ["LEDGER.csv:1-6"]` to read physical lines 1–6
(inclusive, starting at 1) without a semantic query. This gives the header and
five records only when each CSV record occupies one line; quoted records can
span lines. The result includes `totalLines` and, when more lines remain, a
`files[].next` path selector. Pass that selector in `paths` and the returned
`source.sha` in `at` to continue reading the same revision. The final window
has no continuation. `next` is an output field, not an input cursor.

Exact reads retain the 1 MiB source-file limit and 64 KiB response budget.
An oversized selection is refused with line-range guidance; Forge does not
silently truncate it. Line ranges must exist in the selected revision.

Repository queries include `migrations`, `quality`, `policy`, `history`,
`churn`, `languages`, `stats`, `map`, `instructions`, `checks`, `analysis`,
`symbols <path>`, exact `find:<text>` and `upstream <reviewed-public-package>`.
Other natural questions compile a bounded context packet from the immutable
snapshot using parser-backed structure and JEV. `repo="global"` may discover
public repositories by name. Public code discovery must use an explicit form such
as `code:needle repo:owner/repository`; Forge verifies every named repository is
public before issuing the code search, because GitHub code search has no public-
visibility qualifier. If semantic or public-scope evidence cannot be established,
Forge says so; it does not silently widen the search or switch modes.

### forge_edit

Content and replacements are literal, well-formed Unicode text stored as UTF-8.
Invalid Unicode is refused before GitHub work.

Prefers **exact fragment replacement** or a revision-checked selector over
whole files. A fragment that is missing or appears twice is refused rather than
guessed; Forge does not normalize whitespace or indentation to make a match.
Structured edits carry the commit they were selected from, so stale source is
refused before any blob is written. Large existing files cannot be replaced
wholesale.

GitHub updates the branch only if its head still matches the revision Forge
checked. A rewind or divergence is refused; unrelated forward changes can be
reapplied after a complete changed-path comparison.

Bounds: 10 files and 200 KB per call. Exceeding either is refused, never
truncated.

### forge_merge and forge_discard

Neither performs anything itself. Each records what you were shown and returns a
link. When you approve, Forge carries it out server-side and re-checks that
nothing moved in the meantime — a branch that changed after you looked will not
be merged or deleted on the strength of a decision you made about something
else.

If GitHub or result storage cannot confirm the outcome, the link says it is
unconfirmed and points to GitHub for inspection. The approval cannot run again.
A missing private resource is not treated as proof that it was deleted.

Forge currently refuses merge preparation when code-owner review, approval of
the latest push, or resolved review threads are required: it cannot establish
those conditions independently. Complete those merges on GitHub.

### forge_see

Capture is available only to explicitly allowed service users with separate
consent. Your GitHub login must be in both `FORGE_ALLOWED_LOGINS` and
`FORGE_CAPTURE_ALLOWED_LOGINS`. Empty `FORGE_CAPTURE_ALLOWED_LOGINS` denies before quota/provider work.
Keep capture limited to people you trust. Forge checks the requested URL, but
relies on the rendering provider to isolate the resulting browser requests.

The URL must already be publicly reachable. Initial URL checks reject local
hostnames and IP literals, and Browser Rendering is told to reject redirects
to literal local/private destinations. Arbitrary-host capture still relies on
the rendering platform's network boundary for hostname-to-private-IP resolution;
it is not equivalent to a fixed hostname allowlist. Images come back inline with
the same tool call; Forge does not retain a screenshot gallery.

Each image is the top of the page at that viewport, not the full scrollable
page. Default viewports are phone and desktop.

A screenshot can show a server's denial or error page. Forge discloses the
target HTTP error in the receipt even when the snapshot API itself succeeded.

---

## Limits

These are the defaults; your operator may set different limits.

| | |
|---|---|
| Capture attempts | 30 per person per UTC day, counted after input validation |
| GitHub work | your GitHub allowance, with bounded requests and results |
| Semantic context | shared default 200 inference calls/day and 4 concurrent, plus bounded source |
| Approval links | expire after 7 days |

Capture attempts remain counted when provider responses fail, exceed local
limits or cannot be delivered; the browser may already have done the work.
Unknown inference attempts stay counted and reserve capacity for a fixed 60
seconds; missing D1 budget state refuses inference. Call limits are not a billing
guarantee. Each instance's operator pays for hosting and semantic inference;
client subscriptions are separate. GitHub operations use your
GitHub App user authorization and its rate limit.

## What Forge will not do

- Run, build, test or deploy anything. Use a coding agent for that.
- Open more than one Forge change in a repository.
- Capture anything not publicly reachable.
- Keep a copy of your repository.
- Return credential values to a model; the stored GitHub credential stays encrypted.

## When something goes wrong

Every failure says what happened, whether GitHub changed, and at most one thing
to do next. A result never claims success for work that did not land, and never
tells you to retry something that may already have happened.

If a tool says the App is not installed, install it with the link it gives you.
If a change cannot be found, the error names the changes that do exist.
