# Forge

Bring the conversation into your project. Forge lets a conversation read GitHub
source and save research, decisions and changes as ordinary commits or draft
pull requests. Your next coding session can pick up the work from the repository.

[Website](https://timcoy.uk/forge) · [Documentation](./docs/README.md) ·
[Self-hosting](./docs/self-hosting.md) · [Contributing](./CONTRIBUTING.md)

## What it does

- Read exact files, source-backed context and GitHub execution evidence.
- Commit documents, content and code directly, or prepare a proposed change.
- Return a human approval link for merging or discarding proposed work.
- Capture already-public pages inline for enabled, consenting accounts.

Forge has five tools. GitHub keeps repository truth; Forge does not run code.
Builds, tests, previews and deployments belong in your coding environment.
Proposed work uses one fixed `forge` branch and draft PR per repository.

## Run your own copy

Forge is open source under the [MIT licence](./LICENSE). Use it, adapt it and
run your own copy with the [self-hosting guide](./docs/self-hosting.md) and
independent configuration template. You need your own GitHub App, Cloudflare
resources and credentials. Semantic questions use the configured JEV service;
the guide explains private
source processing, missing credentials and provider costs. Client subscriptions
are separate. Independent fresh-account setup remains unverified.

Start with [Using Forge](./docs/using-forge.md) for connection instructions,
examples, permissions, the five tools and their limits. Connect to your own
instance's server URL and GitHub App.

## Access control

Each operator sets an explicit GitHub login allowlist. Missing or invalid values
deny access. Capture requires separate consent. The [self-hosting guide](./docs/self-hosting.md)
explains configuration, provider costs and connection checks.

## Work on Forge

Read [CONTRIBUTING.md](./CONTRIBUTING.md) for installation and meaningful checks.
Report sensitive issues through [SECURITY.md](./SECURITY.md).

- [`worker/`](./worker) contains the implementation and local commands.
- [SIMPLE.md](./SIMPLE.md) records repository constraints and invariants.
- [Context engine](./docs/plans/context-engine.md) owns the active architecture.
- [Operating Forge](./docs/operating-forge.md) owns deployment and recovery.
- [Assets](./assets/README.md) and [DESIGN.md](./DESIGN.md) describe the identity.

## Licence and history

Project code and documentation are [MIT licensed](./LICENSE). Retain the licence
notice when reusing the source. Dependencies and the self-hosted Onest font keep
their own licences; see the [dependency inventory](./docs/research/adoption-register.md#direct-dependency-licences--23-october-2026)
and [font licence](./worker/assets/fonts/OFL.txt).

Earlier Forge versions ran code and maintained workspaces. Execution moved into
coding tools so the conversation's work could stay durable in GitHub. The
[history](./docs/research/forge-history-tool-learnings.md) retains the failures
and decisions behind that boundary.
