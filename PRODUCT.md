# Forge

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who use a conversation to research, decide and author work for GitHub
projects, often in ChatGPT on a phone. Coding tools pick up the committed work
afterwards. Public visitors run their own copy or contribute to the MIT-licensed
source.

## Product purpose

Keep useful research, decisions and changes in the project rather than leaving
them inside a conversation. Forge reads authorised GitHub source and makes
work as ordinary commits and draft pull requests.

## Positioning

The conversation works with the repository. GitHub keeps the result, so the next
coding session can use it without another manual handoff. Forge provides five
tools and public-page captures; the coding host owns execution.

## Operating context

GitHub App user permissions intersect with the person's repository permissions.
Routine writes commit directly; proposed work uses one fixed `forge` branch per
repository. Merge and discard require a human to open an approval link.

People run the MIT-licensed source with their own GitHub App, Cloudflare
resources and credentials. Operators pay their own
provider costs; client plans are separate. Service access uses an explicit
GitHub login allowlist; capture consent is separate. The [release checklist](./docs/going-live.md) covers updates and connection checks.

## Capabilities and constraints

- Read exact source, source-backed context and GitHub execution evidence.
- Commit research, documents, content and code directly or as a proposed change.
- Return inline captures of already-public pages for enabled consenting accounts.
- Keep builds, tests, previews and deployments in the coding host.
- Retain one configured JEV inference route and explicit private-source policy.
- Keep identity, authority, source revisions and incomplete evidence visible.

The [context-engine contract](./docs/plans/context-engine.md) and
[SIMPLE.md](./SIMPLE.md) own technical boundaries. The public site must not promise
unrestricted hosted installation, universal client writes, runtime execution,
measured retrieval improvements or provider network isolation.

## Brand commitments

Use the Forge name and existing anvil from [assets](./assets/README.md). The
site should be clear and the docs easy to read. Explain the GitHub handoff
in plain language.

## Public claims

Describe the implemented product and link to the source and setup guide.
Keep deployment records private. Label illustrative workflows as examples;
do not invent customer testimonials or performance claims.

## Product principles

- Show the durable result, not an invented execution environment.
- Make the first useful task and its setup easy to find.
- Keep public instructions, source and available tools consistent.
- Let people use, self-host or contribute without adopting an entire agent stack.

## First-time visitors

Explain Forge first, then lead visitors to the self-hosting guide and source.
Do not expose operator endpoints, App links, configuration or deployment records.
Keep author attribution separate from operator identity. No public preview,
waitlist or marketplace promise.
