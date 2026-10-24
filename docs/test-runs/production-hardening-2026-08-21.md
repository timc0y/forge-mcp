# Production hardening run — 21 August 2026

**Surface:** live Forge Worker and GitHub approval pages  
**Server:** `https://timcoy.uk/forge`  
**Repository:** `timc0y/forge-mcp`  
**Purpose:** verify the public-exposure hardening release and the mounted
approval path end to end.

## Release

- PR [#66](https://github.com/timc0y/forge-mcp/pull/66) passed Types and
  Invariants in GitHub Actions and merged to `main` as
  `8e688c81af3219fd2ecd4507e2717e191d27d571`.
- D1 migration `0003_security_hardening.sql` applied to `forge-v1-production`.
  A follow-up migration check reported no pending migrations.
- Worker version `af2a2097-5fa6-4c41-8b83-93f01c18af4c` deployed to the
  `timcoy.uk/forge` routes.
- Production smoke suite: **46 passed, 0 failed**.

## Approval path

1. Created disposable PR #75, `mounted approval live smoke`.
2. Opened its signed approval page through `/forge/approvals/...`.
3. Confirmed the form action was relative (`?t=...`), so submission stayed on
   the `/forge` mount instead of posting to the site root.
4. Approved discard; the page returned **Forge — Discarded**.
5. Confirmed PR #75 was closed and branch
   `forge/mounted-approval-live-smoke` no longer existed.

## OAuth recovery

Invalid or spent refresh grants now return a standard `invalid_grant` response
with a direct recovery instruction: reconnect Forge. Existing pre-hardening
signed refresh tokens still require one reconnect because they were never stored
server-side and cannot be safely rotated after the fact.

## Remaining deployment controls

Cloudflare edge rate limits and the Workers Paid spend notification remain
pending. The current Wrangler token has Workers/D1 write access but only zone
read access and no billing-alert write access. No claim of completion is made
for those settings.
