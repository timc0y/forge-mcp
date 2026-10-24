# Forge

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who use a conversation to research, decide and author work for GitHub
projects, often in ChatGPT on a phone. Coding tools pick up the committed work
afterwards. Public visitors run their own copy or contribute to the MIT-licensed
source. Tim uses his own private hosted instance.
These are the existing audiences in [SIMPLE.md](./SIMPLE.md).

## Product purpose

Keep useful research, decisions and changes in the project rather than leaving
them inside a conversation. Forge reads authorised GitHub source and makes
authorised work durable as ordinary commits and draft pull requests.

## Positioning

The conversation works with the repository. GitHub keeps the result, so the next
coding session can use it without another manual handoff. Forge provides five
tools and public-page captures; the coding host owns execution.

## Operating context

GitHub App user permissions intersect with the person's repository permissions.
Routine writes commit directly; proposed work uses one fixed `forge` branch per
repository. Merge and discard require a human to open an approval link.

Tim's hosted endpoint and GitHub App are private for his own use. The public
path is the MIT-licensed source and independent self-hosting with the operator's
own GitHub App, Cloudflare resources and credentials. Operators pay their own
provider costs; client plans are separate. Service access uses an explicit
GitHub login allowlist; capture consent is separate. Independent fresh-account
setup remains unverified. The [release status](./docs/going-live.md) records
deployment and client proof, not inferred from a successful deploy.

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
current redesign brief asks for clean marketing, readable docs and Mobbin
references. Product language stays direct and specific to the GitHub handoff.

## Evidence on hand

Working source, exact source/test regressions, a dated deployment record and
explicit remaining gates. [Operations](./docs/operating-forge.md) records the
deployed version and the reviewed working-tree hash. The source includes an MIT
licence and a self-host guide; source availability and independent setup proof are
separate facts. There are no supplied customer testimonials or measured live
retrieval gains to advertise. Illustrative workflows must be labelled examples.

## Product principles

- Show the durable result, not an invented execution environment.
- Make the first useful task and its setup easy to find.
- Keep public instructions, source and available tools consistent.
- Let people use, self-host or contribute without adopting an entire agent stack.

## First-time visitors

Explain Forge first, then lead visitors to the self-hosting guide and source.
Label the instance's connection panel private and use its configured server URL
and App. Keep author attribution separate from operator contact. No public
preview, waitlist or marketplace promise. Confirmed on 24 October 2026.
