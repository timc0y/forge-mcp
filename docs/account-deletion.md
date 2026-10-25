# Account deletion runbook

Use this guide to remove a person's Forge account and stored data. Confirm
their identity first. Older installations may have capture objects to remove
before deleting the database records that identify them.

Run from `worker/`. The commands below explicitly select your ignored
`wrangler.self-host.jsonc` and its `METADATA` binding. This is a manual production mutation: confirm the request and target
account and database before running it.

## 1. Confirm identity and inventory

Confirm the request through a private response route and verify control of the
GitHub account. Ask the person to revoke the GitHub App installation and disconnect
their client; deleting Forge state does not revoke GitHub's grant. Do not ask
for tokens or private repository names.

```sh
pnpm exec wrangler d1 execute METADATA --config wrangler.self-host.jsonc --remote --json \
  --command="SELECT id, github_user_id, github_login, installation_id, created_at FROM users WHERE lower(github_login) = lower('LOGIN');"
```

Verify the numeric GitHub user ID with the requester. Use the returned Forge
`id` in every remaining query; logins can be renamed. Replace the literal
`FORGE_USER_ID` below with that verified ID in a private SQL file.

Review applied migrations and the actual database schema. Inventory both
`user_id` columns and foreign keys pointing to `users`:

```sql
SELECT m.name AS owned_table, p.name AS owner_column
FROM sqlite_schema AS m JOIN pragma_table_info(m.name) AS p
WHERE m.type = 'table' AND (p.name = 'user_id' OR (m.name = 'users' AND p.name = 'id'))
ORDER BY m.name;
SELECT m.name AS child_table, f."from" AS child_column
FROM sqlite_schema AS m JOIN pragma_foreign_key_list(m.name) AS f
WHERE m.type = 'table' AND f."table" = 'users'
ORDER BY m.name;
```

The repository migrations currently identify `users` plus `approvals`,
`oauth_codes`, `oauth_refresh_tokens`, `capture_usage` and historical `captures`.
If the deployed schema contains another owned table, account for it before
deleting the user. `oauth_clients` is shared client registration metadata, not
one user's record. Migration `0004_semantic_budget.sql` stores daily aggregate
counts and temporary anonymous reservations; it has no user/source/path ownership
to select for account deletion. This is separate from per-user capture counters.

## 2. Account for historical capture objects

Privately query `SELECT id, object_key, created_at, expires_at FROM captures WHERE
user_id = 'FORGE_USER_ID';` before deleting the ownership rows. The table came
from migration `0002_capture_ownership.sql`; current runtime does not populate it.

Use historical deployment/configuration records to identify the old bucket and
all objects belonging to these captures, including any objects not mapped by
early deployments. Confirm their removal through the storage provider, or record
the actual retention/deletion evidence. An expired link or a removed R2 binding
does not prove the object was deleted. Do not invent a bucket, key suffix or
completed deletion. If the old storage cannot be identified or checked, keep the
ownership mapping privately and report that deletion as incomplete before
proceeding; do not discard the only means to locate the person's objects.

The current deployment requires no R2 credential or binding. Historical storage
inspection/removal is a separate authorised operator action, not a new runtime
storage path.

## 3. Delete database state

Once historical-object handling is complete, save the following SQL privately
and execute it as one file with `wrangler d1 execute METADATA --config
wrangler.jsonc --remote --file PATH_TO_PRIVATE_SQL`. Wrangler 4.141.0 removes a
single `BEGIN TRANSACTION;` / `COMMIT;` wrapper and lets D1 transact the file;
this wrapper is supported. Keep foreign-key enforcement enabled.

```sql
BEGIN TRANSACTION;
DELETE FROM approvals WHERE user_id = 'FORGE_USER_ID';
DELETE FROM oauth_refresh_tokens WHERE user_id = 'FORGE_USER_ID';
DELETE FROM oauth_codes WHERE user_id = 'FORGE_USER_ID';
DELETE FROM capture_usage WHERE user_id = 'FORGE_USER_ID';
DELETE FROM captures WHERE user_id = 'FORGE_USER_ID';
DELETE FROM users WHERE id = 'FORGE_USER_ID';
COMMIT;
```

Before: the SQL omitted `captures`, so a retained ownership row blocked the
`users` deletion with `FOREIGN KEY constraint failed`. After: it deletes that
ownership row before its user, once historical objects have been accounted for.
Do not disable foreign keys to make an incomplete deletion appear successful.

## 4. Verify all owned records

Run against the same database and verified ID:

```sql
SELECT count(*) AS users_remaining FROM users WHERE id = 'FORGE_USER_ID';
SELECT count(*) AS approvals_remaining FROM approvals WHERE user_id = 'FORGE_USER_ID';
SELECT count(*) AS refresh_tokens_remaining FROM oauth_refresh_tokens WHERE user_id = 'FORGE_USER_ID';
SELECT count(*) AS oauth_codes_remaining FROM oauth_codes WHERE user_id = 'FORGE_USER_ID';
SELECT count(*) AS capture_usage_remaining FROM capture_usage WHERE user_id = 'FORGE_USER_ID';
SELECT count(*) AS captures_remaining FROM captures WHERE user_id = 'FORGE_USER_ID';
PRAGMA foreign_key_check;
```

Every count must be zero and there must be no foreign-key violations. Reconcile
these queries with the schema inventory; do not verify only approvals/refresh
tokens. Record request/completion dates, Forge user ID and historical-storage
completion or a named unresolved limit in the private support record. Remove
temporary SQL/ownership exports after completion; do not retain deleted evidence
in the support record.

`node --test worker/scripts/account-deletion.node-test.mjs` (Node 22.13+) applies the
actual migrations to SQLite with foreign keys enabled, demonstrates the omitted
`captures` failure, then executes the SQL above and verifies every owned table
while retaining another user's records. This proves the local runbook SQL, not
production data removal or historical R2 cleanup.
