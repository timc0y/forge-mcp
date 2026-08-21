<img src="assets/forge-app-icon.svg" width="72" alt="">

# Forge

Think in ChatGPT. Commit safely to GitHub.

Forge is the hosted handoff between a conversation and a repository. Research,
visual reviews and small edits become real commits and draft pull requests.
GitHub remains the only copy, and `main` moves only after a human approves it.

Forge complements Codex, Claude Code, Cursor and OpenCode. It has no runner and
does not build, test, serve or deploy code itself. Its GitHub commits are normal
GitHub writes, so repository automation may react to them.

## Three useful first jobs

- **Research → repository** — save a plan, decision or brief where the next
  coding session can use it.
- **Live page → visual review** — capture phone and desktop, then turn the
  findings into a document or a small corrective change.
- **Small edit → draft pull request** — fix copy, CSS or documentation from a
  conversation without touching `main`.

## Five tools

| Tool | Gate |
|---|---|
| `forge_read` — repos → tree → a change → file contents or patches | free |
| `forge_edit` — write files; creates the repo and the change if new | free |
| `forge_merge` — returns one link a human opens | **approved** |
| `forge_discard` — returns one link a human opens | **approved** |
| `forge_see` — capture a public URL | free, quota'd |

You never name a branch. Describe the intent — "pricing section" — and say those
words again to continue that change. Every result lists the repo's open changes,
so nothing has to be remembered between turns. `main` moves only through a merge
a human approved.

**Free research preview** — open to anyone with a GitHub account, at
**<https://timcoy.uk/forge>**. Client support varies by plan and surface; the
[current ChatGPT availability note](./docs/research/chatgpt-availability-2026-08-20.md)
records what is documented and what still needs testing.

## Where things are

- **[Using Forge](./docs/using-forge.md)** — connect it, install the App, and
  what the tools do.
- **[Operating Forge](./docs/operating-forge.md)** — config, secrets, cost.
- [`worker/`](./worker) — the implementation.
- [`assets/`](./assets) — the mark, and the app icon in both tones.
- [`SIMPLE.md`](./SIMPLE.md) — the design profile: what is real, what is
  preserved, and the precedents that must not be re-litigated.
- [`docs/plans/forge-v1.md`](./docs/plans/forge-v1.md) — the architecture this was built to.
- [`docs/plans/product-route.md`](./docs/plans/product-route.md) — the active adoption,
  measurement and revenue plan.
- [`docs/research/`](./docs/research) — the record. Read
  [`forge-history-tool-learnings.md`](./docs/research/forge-history-tool-learnings.md)
  before changing anything: it is a register of production failures and the
  invariants they bought.

## Working on it

```sh
pnpm check                # types and invariants
pnpm dev
worker/scripts/smoke.sh   # 28 checks against the deployment
```

## History

The first Forge ran code. It had containers, an executor, workspaces, shell,
previews, deployments, and forty-five MCP tools. Nearly every production failure
it recorded traced to compute holding state GitHub did not — lost workspace ids,
local-only edits a reaper could erase, commands dying in the transport while
continuing remotely. Each fix was a mitigation; the cause remained and kept
producing recovery tools, so the catalog grew back after every cut.

Running code moved elsewhere, which removed the executor's last justification.
What replaced it is two organs, five tools, one durable plane and no second copy
of anything. The old implementation is in this repository's history; its
lessons are in `docs/research/` and its invariants are in `SIMPLE.md`.
