# Documentation

Forge connects a conversation to GitHub. Read the project, save the useful work
as a commit, and let the next coding session pick it up from the repository.

## Run your own Forge

Forge's code and documentation are [MIT licensed](../LICENSE) for reuse.
The [self-hosting guide](./self-hosting.md) takes you through your own GitHub App,
Cloudflare resources, credentials, migrations and a disposable first commit.
You pay your providers and supply your own client plan. The guide explains JEV
source processing and costs. Independent fresh-account setup remains unverified.

Tim's hosted endpoint and GitHub App are his private deployment. They are not a
public preview or a public installation path. Check the [release status](./going-live.md)
for the private deployment and tested client capabilities.

## Start with a useful task

[Using Forge](./using-forge.md) covers connecting to your instance, choosing
repositories, reading source, saving decisions and preparing changes. It includes
the five tools, permissions and practical limits.

## Understand the system

The [context engine](./plans/context-engine.md) describes source retrieval,
parser-backed selection, JEV and exact-commit evidence. [SIMPLE.md](../SIMPLE.md)
records the repository's constraints. The [product route](./plans/product-route.md)
records the private-hosted and open-source decision, with earlier commercial
hypotheses retained as history.

## Operate an instance

[Operating Forge](./operating-forge.md) covers configuration, secrets, cost,
deployment, client catalogue refresh and recovery. The
[account-deletion runbook](./account-deletion.md) explains manual privacy controls.

## Contribute or investigate

Read [Contributing](../CONTRIBUTING.md) for local setup and checks, and
[Security](../SECURITY.md) for private reporting. Code and documentation are
[MIT licensed](../LICENSE); dependencies retain their own notices.

The [history](./research/forge-history-tool-learnings.md) retains production
lessons. [Research](./research/) and [test runs](./test-runs/) are dated evidence,
not promises of current availability. The [V1 design](./plans/forge-v1.md) is
historical; [release status](./going-live.md) owns current release proof.
