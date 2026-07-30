# Forge MCP validation

Last verified on 30 July 2026 in the current workspace.

## Passed

- `pnpm check`
  - dependency-boundary validation across 11 domain packages
  - tool/catalogue and live-D1 wiring validation (41 tools, 25 tables)
  - strict TypeScript checks across 24 workspace packages
  - 77 test files and 573 tests passed
  - generated MCP tool schemas matched the checked-in schemas
- `pnpm cf:typegen` and `wrangler deploy --dry-run --containers-rollout=none`
  - generated bindings and the production Worker deployment graph validated.
- `pnpm run deploy:worker`
  - production Worker version `d3b687b1-8b78-4137-bffc-4eb6c81140dd` deployed;
    no pending D1 migrations.
  - `/health`, `/ready`, and the OAuth protected-resource metadata endpoint
    returned healthy production responses.
- `pnpm acceptance:cloud`
  - authenticated MCP acceptance provisioned a public-repository workspace,
    executed it, captured phone and desktop evidence with zero findings, and
    destroyed it successfully.

## Environment-limited validation

The release used `deploy:worker`, so it did not build or roll out a new Sandbox
container image. Run the full Docker-backed deploy whenever `Dockerfile` or the
container configuration changes. Cloud acceptance used the public fixture; a
private GitHub App installation remains a separate operator check.
