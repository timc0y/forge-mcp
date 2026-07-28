-- workspace-resolve.ts now addresses a workspace by (owner, repo, branch)
-- instead of an opaque workspace_id a chat client cannot be trusted to carry
-- across turns. That only stays unambiguous if two LIVE workspaces for the
-- same tenant can never sit on the same repository + branch at once —
-- otherwise "all three given" would have more than one match to choose from,
-- which is exactly the ambiguity this whole redesign exists to avoid.
--
-- packages/application/src/index.ts:1287 already adopts an existing agent
-- branch rather than always cutting a new one, and workspaces.current_branch
-- (migrations/d1/0001_initial.sql) has never carried a uniqueness constraint,
-- so two concurrent forge_workspace_create calls for the same repository and
-- ref could otherwise leave two rows pointing at the same (tenant,
-- repository, branch) with nothing at the data layer to stop it. Enforced
-- here rather than only in application code so the guarantee holds even if a
-- future code path forgets to check.
--
-- Partial, not a plain UNIQUE constraint: only non-terminal workspaces
-- participate (the same TERMINAL_STATES list as
-- apps/forge-edge-gateway/src/capacity.ts and the "live" filter in
-- workspace-resolve.ts), so a destroyed or failed workspace never blocks a
-- fresh one from reusing its branch. SQLite (and D1) partial indexes support
-- an arbitrary WHERE clause on CREATE INDEX — already relied on by
-- migrations/d1/0018_credential_profiles.sql's idx_credential_profiles_active
-- — and SQLite's uniqueness rules never treat two NULLs as equal, so the many
-- freshly-created workspaces that have no current_branch yet (it is not set
-- until the workspace reaches its first commit) do not collide with each
-- other here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_tenant_repo_branch_live
  ON workspaces (tenant_id, repository, current_branch)
  WHERE state NOT IN ('suspended', 'failed', 'destroying', 'destroyed');
