# Using Forge

Think in ChatGPT. Commit safely to GitHub.

Forge is the hosted handoff between a conversation and a repository. It turns
research, visual reviews and small edits into durable commits and draft pull
requests. It does not run your code, and GitHub remains the only copy.

Start with one of three jobs:

- Save a plan, decision or brief in the repository where the next coding session
  can use it.
- Capture a public page at phone and desktop, then record the findings or make a
  small correction.
- Fix copy, CSS or documentation from a conversation without touching `main`.

Free research preview by design. As of 21 September 2026 the GitHub App registration is still private, so unrelated GitHub accounts cannot install it until the owner changes the App visibility to public.

---

## The words Forge uses

There are three nouns, and you only ever handle two of them.

**Repository** — yours, on GitHub. Forge never keeps a copy. If Forge vanished
tomorrow your repositories would look completely normal, because everything it
did was an ordinary commit.

**Change** — work held for review. Forge uses one fixed `forge` branch and one
draft pull request. Each new proposed edit continues it. A repository cannot
have two active Forge changes.

**Capture** — a screenshot of a page that is already public, returned inline with
the tool call.

That is the whole vocabulary. There is no workspace, no session, no task, no job
and no id to carry.

## The rules that make it safe

**A commit is durable the moment a tool returns.** There is no push step, no
staging area, no "unsaved" state. If `forge_edit` reports success, the commit is
on GitHub with a SHA and a URL you can open. Forge has no runner of its own, but
normal repository automation (for example GitHub Actions triggered by a push)
may react to that commit just as it would to any other GitHub write.

**Routine work becomes repository truth immediately.** Plans, research,
direction and routine content go to the default branch. Work that needs review
goes to the Forge change and needs your approval before it lands.

**Two things need approval: merging and discarding.** Everything else is
additive — a commit only ever adds, and a change you abandon is still there
tomorrow. Merging moves what everything else treats as truth, and discarding
destroys work. Both send you one link showing exactly what would land, or how
many commits would stop being reachable. The link keeps working after the
conversation ends, so you can decide later, from any device.

**Nothing is created by ceremony.** Write to a repository that does not exist and
Forge creates it. Ask to hold work for review and Forge creates the one change.
You do not make a repository, name a branch, or open a pull request first.

---

## Getting connected

> **ChatGPT availability changes by account, rollout, plan and surface.** OpenAI
> currently documents read/fetch custom MCP access for Pro and full write/modify
> access for supported Business, Enterprise and Edu web workspaces. However, the
> production ChatGPT web session recorded on 20 August 2026 successfully used
> Forge's write tools from a browser on an iPhone. Deep Research remains
> read-only, and the native mobile app is documented as unsupported. See the
> dated [availability note](./research/chatgpt-availability-2026-08-20.md) rather
> than treating either the documentation or one account as a universal contract.

### 1. Add the server to your client

```
https://timcoy.uk/forge/mcp
```

**ChatGPT** — Settings → Apps → Advanced settings → Developer mode, then add
a custom app with that URL.

**Claude** — Settings → Connectors → Add custom connector. Or from Claude Code:

```sh
claude mcp add --transport http --scope user forge https://timcoy.uk/forge/mcp
```

### 2. Authorize

Your client opens a Forge page telling you what it is about to be allowed to do.
Continue from there and GitHub asks whether to let Forge act as you.

That is the last time tokens come up. Forge holds one GitHub user credential
encrypted for two narrow operations: creating a repository on your account and
an explicit public GitHub search. All work inside installed repositories uses
the repository-scoped GitHub App installation instead.

### 3. Install the GitHub App

Authorizing tells Forge **who you are**. Installing tells it **which
repositories it may touch**. They are deliberately separate.

```
https://github.com/apps/forge-mcp-github-app/installations/new
```

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

Repository queries include `migrations`, `quality`, `policy`, `history`,
`churn`, `languages`, `stats`, `map`, `instructions`, `checks`, `analysis`,
`symbols <path>`, exact `find:<text>` and `upstream <reviewed-public-package>`.
Other natural questions compile a bounded context packet from the immutable
snapshot using parser-backed structure and JEV. If semantic evidence cannot be
produced, Forge says so; it does not silently switch to another search mode.

### forge_edit

Prefers **exact fragment replacement** or a revision-checked selector over
whole files. A fragment that is missing or appears twice is refused rather than
guessed; Forge does not normalize whitespace or indentation to make a match.
Structured edits carry the commit they were selected from, so stale source is
refused before any blob is written. Large existing files cannot be replaced
wholesale.

Bounds: 10 files and 200 KB per call. Exceeding either is refused, never
truncated.

### forge_merge and forge_discard

Neither performs anything itself. Each records what you were shown and returns a
link. When you approve, Forge carries it out server-side and re-checks that
nothing moved in the meantime — a branch that changed after you looked will not
be merged or deleted on the strength of a decision you made about something
else.

### forge_see

The URL must already be publicly reachable. Private addresses, local addresses
and IP literals are refused, and Browser Rendering is told to reject redirects
to literal local/private destinations. Arbitrary-host capture still relies on
the rendering platform's network boundary for hostname-to-private-IP resolution;
it is not equivalent to a fixed hostname allowlist. Images come back inline with
the same tool call; Forge does not retain a screenshot gallery.

Each image is the top of the page at that viewport, not the full scrollable
page. Default viewports are phone and desktop.

---

## Limits

| | |
|---|---|
| Captures | 30 per person per UTC day |
| Everything else | unlimited — it runs against your own GitHub allowance |
| Approval links | expire after 7 days |

Repository work costs Forge nothing, because every call is metered against the
GitHub App installation *you* granted. Only capture spends Forge's money, which
is why it is the only thing with a number on it.

## What Forge will not do

- Run, build, test or deploy anything. Use a coding agent for that.
- Open more than one Forge change in a repository.
- Capture anything not publicly reachable.
- Keep a copy of your repository.
- Show a model your secrets — it holds none of yours.

## When something goes wrong

Every failure says what happened, whether GitHub changed, and at most one thing
to do next. A result never claims success for work that did not land, and never
tells you to retry something that may already have happened.

If a tool says the App is not installed, install it with the link it gives you.
If a change cannot be found, the error names the changes that do exist.
