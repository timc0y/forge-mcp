# Product

> Forge gives compatible AI clients a safe remote development computer. The
> client supplies reasoning; Forge supplies repository state, execution,
> previews, browser evidence, Git operations and durable task context.

The stable product statement and hosted/self-managed deployment model are
described in [`../PRODUCT-PLAN.md`](../PRODUCT-PLAN.md).

## Target user

A single developer (or small team) who wants a ChatGPT/Codex/Claude conversation
to do real software-development work against one repository, cheaply, without
checking the repository out inside the AI host.

## Product boundaries

Forge is **not** an AI agent, a cloud IDE, general-purpose CI, or a model-routing
platform. It never merges or pushes to the default branch and never invents a
second review format beside Parallax.

## Terminology

Task, Workspace, Process, Preview, Browser session, Evidence, Artifact, Approval
— defined in [`../README.md`](../README.md). "Preview" is never a screenshot;
"workspace" is never a task; "browser" is never an application preview.

## Supported workflows

Durable coding tasks, bounded GitHub repository context, guarded `forge_edit`
commits, targeted verification in an ephemeral executor, private previews,
structured functional journeys, browser evidence, and approval-gated PR review. See
[`../plans/chatgpt-first.md`](../plans/chatgpt-first.md).
