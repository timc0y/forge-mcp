PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS deploy_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL DEFAULT 'github',
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  label TEXT NOT NULL,
  workflow TEXT NOT NULL,
  environment TEXT NOT NULL,
  cwd TEXT NOT NULL,
  command TEXT NOT NULL,
  expected_url TEXT,
  expected_worker_name TEXT,
  account_id TEXT,
  map_env TEXT NOT NULL DEFAULT '{}',
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  source_hint TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'approved' CHECK (state IN ('approved', 'stale', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deploy_profiles_repo ON deploy_profiles(tenant_id, provider, owner, repo, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deploy_profiles_repo_label ON deploy_profiles(tenant_id, provider, owner, repo, label);
