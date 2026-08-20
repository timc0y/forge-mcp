# Product route: adoption and revenue

**Status:** Active validation plan  
**Date:** 20 August 2026

## Product claim

**Think in ChatGPT. Commit safely to GitHub.**

Forge is the safe, hosted handoff between a conversation and a repository. It
turns research, visual reviews and small edits into real commits and draft pull
requests. GitHub remains the source of truth, and the default branch moves only
after a human approves it.

Forge complements Codex, Claude Code, Cursor and OpenCode. It is not a weaker
coding agent and should not be sold as one: it has no shell, runner, build,
test, preview or deployment plane.

## First user and buyer

The first user is a technical founder, indie developer, design engineer or open
source maintainer who already alternates between ChatGPT and a coding agent.
They understand GitHub, value draft pull requests and sometimes notice or plan
work away from a terminal.

The first plausible buyer is a small product team. Business, Enterprise and Edu
workspaces have publicly documented controls for write actions, while the
production Forge session also demonstrated writes in a ChatGPT runtime outside
that simple documented matrix. Teams remain the stronger paid hypothesis because
governance, shared workflows and support create a buying reason; not because
individual ChatGPT sessions are necessarily read-only. The dated
[availability note](../research/chatgpt-availability-2026-08-20.md) records the
discrepancy.

## Three core jobs

### Research to repository

A conversation researches an architecture choice, feature or market and saves
the conclusion as a plan, ADR, README change or implementation brief. The value
is the removed handoff: the conclusion no longer dies in a chat.

### Rendered page to visual review

Forge captures a public page at phone and desktop. The model can identify a
visible problem, read the relevant files, record a review or prepare a small
correction. This combines vision and repository context without giving the
conversation a machine to control.

### Small edit from a conversation

A user can update copy, CSS or documentation and receive a durable commit and
draft pull request. It is especially useful away from a laptop, but the promise
must remain client-agnostic because mobile and MCP availability change.

## Claims not to make

- Do not promise to turn ChatGPT into Codex. DevSpace already owns that framing,
  and Forge deliberately does less execution.
- Do not promise extra or doubled model limits. Separate allowances are a useful
  acquisition conversation, not a stable product contract.
- Do not promise that every ChatGPT plan, model or surface supports writes.
- Do not imply a screenshot is a full-page audit: the current capture is the top
  viewport only.

## Acquisition path

1. Publish one short, continuous demonstration: capture a live site on phone and
   desktop, find one problem, read the file, commit a fix and show the approval
   boundary.
2. Package the product around the three jobs rather than its five tool names.
3. Recruit 20–30 design partners who already use ChatGPT plus a coding agent.
4. Publish evidence-led X posts around research handoff, visual review and safe
   phone/browser changes. Do not lead with MCP vocabulary.
5. Prepare a Plugin Directory submission only after the plan/surface matrix and
   privacy requirements are satisfied.

## Activation and retention

A connection is setup, not activation.

**Primary activation:** the first durable `forge_edit` commit.

**Stronger activation:** `forge_see` followed by a useful repository change or
review document.

Measure, without collecting repository names, URLs, intents, patches or file
contents:

- users who connect and successfully call a tool;
- users who create a durable change;
- whether the change followed a capture;
- approval requests after a change;
- return use within 7 and 14 days;
- the repeated job: research, visual review or small edit.

## Thirty-day sequence

### Week 1 — truth and message

- Complete the plan/model/surface test matrix.
- Deploy the job-led landing page.
- Record the production demonstration.
- Deploy and verify the activation events now emitted by the worker; confirm
  they contain shape only.

### Week 2 — qualified users

Recruit 20 users from the target group. Give each a real research, visual-review
or small-edit task rather than a generic invitation to try Forge. Observe the
authorisation and GitHub App installation drop-offs.

### Week 3 — repetition

Look for a job people repeat without prompting. Build only the missing
capability requested independently by several users. Do not add execution simply
because competitors have it.

### Week 4 — payment intent

Test two clearly labelled hypotheses:

- **Forge Review, £12–£20/month:** full-page and multi-route capture,
  before/after comparison, saved baselines, longer history and structured review
  reports.
- **Forge Teams, £79–£199/month:** organisation installation, shared workflows,
  approval policy, audit history, repository controls, retention settings and
  support.

These are tests, not announced prices. Ask for a pilot, deposit or purchasing
commitment; an email signup alone is not willingness to pay.

## Decision gates

Continue investing when the evidence shows all of the following:

- at least 40% of fully connected design partners create a durable change;
- at least 20% of activated users return within two weeks;
- several users independently repeat the same job;
- at least five request the same paid capability;
- at least three commit money or a team pilot.

If most use is a single experiment to stretch model limits, Forge has an
acquisition trick rather than a durable product.

## Roadmap order

1. Compatibility proof and honest messaging.
2. Activation measurement.
3. The compact semantic outline is implemented. Validate whether users next
   need full-page capture, explicit multi-route review or before/after evidence.
4. Team governance if workspace pilots appear.
5. Billing only after a paid boundary is proven.

Repository execution, private-page browsing and autonomous deployment remain
out of scope unless real users invalidate the five-tool boundary.
