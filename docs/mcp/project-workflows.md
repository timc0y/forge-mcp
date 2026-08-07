# Direct-chat examples

Use Forge from an ordinary ChatGPT or Claude conversation. Connect
`${FORGE_PUBLIC_ORIGIN}/mcp`, complete OAuth, and authorize the repositories you
want Forge to see from the dashboard.

Ask for the outcome in normal language. Forge's tools hide branch, workspace,
process, dependency, and cleanup choreography.

## Improve a design direction document

> Read the design principles in owner/repo. Tighten the typography and motion
> direction, keeping the existing voice, and save the focused update.

The chat can search, read the relevant documents, and make a small remote edit.
It should not create execution compute unless verification actually requires a
command or preview.

## Add an implementation plan

> Read the current architecture around checkout and add a short implementation
> plan under docs/plans. Include scope, non-goals, risks, and acceptance checks.

The plan is an ordinary GitHub edit. No separate task record or workspace is
part of the public flow.

## Change a core file and verify it

> Change the card radius token in owner/repo, run the narrowest relevant check,
> then show me the changed page on phone and desktop.

Forge keeps the edit durable on GitHub before running the check. Command output
cannot silently become a repository edit. Screenshot capture owns preview
startup and returns the visual evidence directly.

## Deploy with saved variables

> List the environments for owner/repo and deploy the current Forge branch to
> staging. Give me the verified URL.

The chat sees environment names and required variable names, never secret
values. Forge uses the saved environment and returns either verified deployment
evidence or a status handle for work that outlives the tool request.

## Review any website

> Screenshot https://example.com on phone, tablet, and desktop. Inspect the
> images and tell me what breaks at each breakpoint.

Public URL capture requires no repository or executor. Branch capture starts or
reuses a temporary preview internally. Partial evidence and limitations are
reported honestly when not every capture fits in the request budget.

For a monorepo or custom server, put a small `forge.json` in the repository
root with `preview.cwd`, `preview.command`, and `preview.port`. Forge reads it
from the GitHub branch before starting the ephemeral server; ChatGPT does not
need to know a workspace, process, or preview id.

## Submit for review

> Submit this Forge branch for my review.

Forge returns an approval URL and keeps the submission durable after the chat
ends. Approval does not require the model to poll or repeat submission.

See [the tool reference](../tools.md) for the ten public operations.
