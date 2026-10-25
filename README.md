# Forge

Bring the conversation into your project. Read GitHub, save a plan or make a
change from your chat. The work lands in your repository, ready for your next
coding session.

[Website](https://timcoy.uk/forge) · [Documentation](./docs/README.md) ·
[Self-hosting](./docs/self-hosting.md) · [Contributing](./CONTRIBUTING.md)

## What it does

- Read files, understand a project and check its GitHub results.
- Commit documents, content and code directly, or prepare a proposed change.
- Review proposed changes before merging or discarding them.
- Bring screenshots of public pages into the conversation when capture is enabled.

Forge has five tools. Changes are saved on GitHub; Forge does not run code.
Builds, tests, previews and deployments belong in your coding environment.
Proposed work uses one fixed `forge` branch and draft PR per repository.

## Run your own copy

Forge is open source under the [MIT licence](./LICENSE). Use it, adapt it and
run your own copy with the [self-hosting guide](./docs/self-hosting.md) and
configuration template. You need your own GitHub App, Cloudflare account and
credentials. The guide covers setup, costs and how source is processed.
Hosting and client subscriptions are separate.

Start with [Using Forge](./docs/using-forge.md) for connection instructions,
examples, permissions, the five tools and their limits. Connect to your own
instance's server URL and GitHub App.

## Access control

Each operator sets an explicit GitHub login allowlist. Missing or invalid values
deny access. Capture requires separate consent. The [self-hosting guide](./docs/self-hosting.md)
explains configuration, provider costs and connection checks.

## Work on Forge

Read [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and checks.
Report sensitive issues through [SECURITY.md](./SECURITY.md).

- [`worker/`](./worker) contains the implementation and local commands.
- [SIMPLE.md](./SIMPLE.md) explains the design constraints.
- [Context engine](./docs/plans/context-engine.md) explains how Forge selects source.
- [Operating Forge](./docs/operating-forge.md) covers deployment and recovery.
- [Assets](./assets/README.md) and [DESIGN.md](./DESIGN.md) describe the identity.

## Licence and history

Project code and documentation are [MIT licensed](./LICENSE). Retain the licence
notice when reusing the source. Dependencies and the self-hosted Onest font keep
their own licences; see the [dependency inventory](./docs/research/adoption-register.md#direct-dependency-licences--23-october-2026)
and [font licence](./worker/assets/fonts/OFL.txt).

Earlier Forge versions ran code and maintained workspaces. Execution moved into
coding tools so the work could stay in GitHub. The
[history](./docs/research/forge-history-tool-learnings.md) explains the decisions behind that change.
