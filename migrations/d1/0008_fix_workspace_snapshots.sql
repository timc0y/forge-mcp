-- 0007 tried to CREATE TABLE IF NOT EXISTS workspace_snapshots, but 0001_initial
-- already defined a table of that name with a different, unused schema (id,
-- provider, manifest_key, ...). So 0007 was a silent no-op and recordSnapshot's
-- INSERT has been failing against the wrong columns — the snapshot feature never
-- persisted anything. The old table is empty and read by no code, so replace it.
DROP TABLE IF EXISTS workspace_snapshots;

CREATE TABLE workspace_snapshots (
  workspace_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER,
  -- Hash of the lockfile captured in the snapshot, so a restore can skip the
  -- dependency install when the current lockfile matches (turbo #2). Nullable
  -- for snapshots taken before this was recorded.
  lockfile_hash TEXT,
  created_at TEXT NOT NULL
);

-- Per-repo dependency cache keyed by (repo, lockfile hash, runtime): lets even a
-- first-ever create of a known repo restore node_modules/pnpm-store from R2
-- instead of a cold install (turbo #1). Keyed by content, not workspace, so it
-- is shared across every workspace of the same repo at the same lockfile.
CREATE TABLE IF NOT EXISTS workspace_deps_cache (
  cache_key TEXT PRIMARY KEY,
  repo_slug TEXT NOT NULL,
  lockfile_hash TEXT NOT NULL,
  runtime_profile TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL
);
