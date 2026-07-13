# Forge MCP validation

Validated on 12 July 2026 in the provided build environment.

## Passed

- `pnpm check`
  - dependency-boundary validation across 10 domain packages
  - strict TypeScript checks across 23 workspace packages
  - 16 unit/domain tests passed
  - 1 Local Docker provider contract test skipped because no Docker daemon was available
  - generated MCP tool schemas matched the checked-in schemas
- `pnpm cf:typegen`
  - Wrangler generated Worker binding/runtime types successfully
- `wrangler deploy --dry-run --containers-rollout=none`
  - Worker bundle completed
  - Durable Object, Workflow, D1, R2, Browser Run and environment bindings validated

## Environment-limited validation

A full container-image dry run was not possible because this environment has no Docker daemon. Wrangler reached the configured image-build step and reported that Docker was required. The Worker deployment graph was then validated with container rollout disabled.

No live Cloudflare account resources, OAuth registration, GitHub App installation or public preview domain were available in this environment, so this ZIP does not claim a production deployment.
