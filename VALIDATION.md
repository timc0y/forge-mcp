# Forge MCP validation

Last verified on 30 July 2026 in the current workspace.

## Passed

- `pnpm check`
  - dependency-boundary validation across 11 domain packages
  - strict TypeScript checks across 24 workspace packages
  - 77 test files and 571 tests passed
  - generated MCP tool schemas matched the checked-in schemas
- `pnpm cf:typegen` and `wrangler deploy --dry-run --containers-rollout=none`
  - previously validated the generated bindings and Worker deployment graph; rerun
    these commands before deployment changes.

## Environment-limited validation

A full container-image dry run requires Docker. Run it whenever `Dockerfile` or
the container configuration changes; the current verification did not exercise
live Cloudflare resources.

No live Cloudflare account resources, OAuth registration, GitHub App installation or public preview domain were available in this environment, so this ZIP does not claim a production deployment.
