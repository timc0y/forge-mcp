# Simple

## Reality

- User/operator: Tim only.
- Purpose: Let Tim use Codex inside ChatGPT to inspect and change his authorised GitHub repositories. Do not design for other users or hosts.
- External surface: Remote MCP actions for repository inspection, editing, execution, preview, deployment, submission, and merging.
- Persistent data: GitHub is the durable repository plane. Cloudflare bindings support metadata, artifacts, coordination, and approvals; live status of every configured resource is not independently proven here.
- Compatibility: Preserve the actions Tim currently uses and the safety boundaries around them; generic tenant, OAuth, Claude, and client code is not evidence of a multi-user obligation.

## Preserve

- Repository-scoped authorization, approval gates, credential isolation, audit/idempotency records, durable branches, verified receipts, and ephemeral-executor cleanup.

## Current boundary

- MCP backend for Codex in ChatGPT to do Tim's repository work. It is not a multi-user product, general agent platform, permanent development machine, or autonomous project manager.

## Ordinary paths

- Extend an existing bounded MCP action through its policy, workflow, approval, and receipt path. Keep durable changes in GitHub and execution state ephemeral.

## Proof

- `pnpm check`
- Focused `pnpm test` or `pnpm test:e2e`
- `pnpm schemas:check`
- Inspect MCP tool and schema registration together.

## Reconsider when

- Tim explicitly authorises another user, another host, or durable autonomous work; establish auth, privacy, cost, and compatibility obligations first.
