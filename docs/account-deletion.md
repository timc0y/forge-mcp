# Account deletion runbook

Forge has no administration dashboard. Account deletion is therefore an explicit
operator procedure, performed from `worker/` against the production D1 database.

## Before starting

- Confirm the request through a private response route. A GitHub login alone is
  not enough when the requester cannot demonstrate control of it.
- Ask the person to revoke the Forge GitHub App installation and disconnect the
  app from their chat client. Deleting Forge's row does not revoke GitHub's own
  grant on their behalf.
- Do not ask for tokens or private repository names.

## 1. Resolve the Forge user

```sh
pnpm exec wrangler d1 execute forge-v1-production --remote --json \
  --command="SELECT id, github_user_id, github_login, installation_id, created_at FROM users WHERE lower(github_login) = lower('LOGIN');"
```

Verify the numeric GitHub user id with the requester. Use the returned Forge
`id` in every remaining query; logins can be renamed.

## 2. Delete database state

Run the following as one SQL file or transaction. Forge V2 stores no captured-page objects outside D1; `capture_usage` is only the per-user daily quota counter:

```sql
BEGIN TRANSACTION;
DELETE FROM approvals WHERE user_id = 'FORGE_USER_ID';
DELETE FROM oauth_refresh_tokens WHERE user_id = 'FORGE_USER_ID';
DELETE FROM oauth_codes WHERE user_id = 'FORGE_USER_ID';
DELETE FROM capture_usage WHERE user_id = 'FORGE_USER_ID';
DELETE FROM users WHERE id = 'FORGE_USER_ID';
COMMIT;
```

`oauth_clients` is shared client registration metadata and is not tied to one
Forge user.

## 3. Verify

```sh
pnpm exec wrangler d1 execute forge-v1-production --remote --json \
  --command="SELECT id FROM users WHERE id = 'FORGE_USER_ID'; SELECT count(*) AS approvals FROM approvals WHERE user_id = 'FORGE_USER_ID'; SELECT count(*) AS refresh_tokens FROM oauth_refresh_tokens WHERE user_id = 'FORGE_USER_ID';"
```

The user query must return no row and all counts must be zero. Record only the
request date, completion date and Forge user id in the operator's private support
record; do not retain the deleted evidence there.
