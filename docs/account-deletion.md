# Account deletion runbook

Forge has no administration dashboard. Account deletion is therefore an explicit
operator procedure, performed from `worker/` against the production D1 database
and R2 bucket.

## Before starting

- Confirm the request through a private response route. A GitHub login alone is
  not enough when the requester cannot demonstrate control of it.
- Ask the person to revoke the Forge GitHub App installation and disconnect the
  app from their chat client. Deleting Forge's row does not revoke GitHub's own
  grant on their behalf.
- Do not ask for tokens, private repository names or captured-page contents.

## 1. Resolve the Forge user

```sh
pnpm exec wrangler d1 execute forge-v1-production --remote --json \
  --command="SELECT id, github_user_id, github_login, installation_id, created_at FROM users WHERE lower(github_login) = lower('LOGIN');"
```

Verify the numeric GitHub user id with the requester. Use the returned Forge
`id` in every remaining query; logins can be renamed.

## 2. List and remove mapped capture objects

```sh
pnpm exec wrangler d1 execute forge-v1-production --remote --json \
  --command="SELECT id, object_key, created_at, expires_at FROM captures WHERE user_id = 'FORGE_USER_ID';"
```

Delete every returned `object_key` from the `forge-v1-captures` bucket using the
Cloudflare R2 dashboard, Wrangler's current object-delete command or the
S3-compatible API. Confirm each object is absent before removing its ownership
row.

Captures made before migration `0002_capture_ownership.sql` have no user mapping.
They remain governed by the bucket's 30-day lifecycle. If the requester supplies
a signed capture link, its UUID identifies the corresponding
`captures/<uuid>.html` object for early deletion.

## 3. Delete database state

Run the following as one SQL file or transaction after the R2 objects are gone:

```sql
BEGIN TRANSACTION;
DELETE FROM captures WHERE user_id = 'FORGE_USER_ID';
DELETE FROM approvals WHERE user_id = 'FORGE_USER_ID';
DELETE FROM oauth_refresh_tokens WHERE user_id = 'FORGE_USER_ID';
DELETE FROM oauth_codes WHERE user_id = 'FORGE_USER_ID';
DELETE FROM capture_usage WHERE user_id = 'FORGE_USER_ID';
DELETE FROM users WHERE id = 'FORGE_USER_ID';
COMMIT;
```

`oauth_clients` is shared client registration metadata and is not tied to one
Forge user.

## 4. Verify

```sh
pnpm exec wrangler d1 execute forge-v1-production --remote --json \
  --command="SELECT id FROM users WHERE id = 'FORGE_USER_ID'; SELECT count(*) AS approvals FROM approvals WHERE user_id = 'FORGE_USER_ID'; SELECT count(*) AS refresh_tokens FROM oauth_refresh_tokens WHERE user_id = 'FORGE_USER_ID'; SELECT count(*) AS captures FROM captures WHERE user_id = 'FORGE_USER_ID';"
```

The user query must return no row and all counts must be zero. Record only the
request date, completion date and Forge user id in the operator's private support
record; do not retain the deleted evidence there.
