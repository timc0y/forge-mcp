PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  avatar_url TEXT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_login_states (
  state_hash TEXT PRIMARY KEY,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS github_install_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

ALTER TABLE github_installations ADD COLUMN account_id TEXT;
ALTER TABLE github_installations ADD COLUMN account_type TEXT;
ALTER TABLE github_installations ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE repositories ADD COLUMN github_repository_id TEXT;
ALTER TABLE repositories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE repositories ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main';

CREATE INDEX IF NOT EXISTS idx_web_sessions_expiry ON web_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_repositories_installation ON repositories(installation_id, authorization_state);
CREATE INDEX IF NOT EXISTS idx_repositories_tenant_slug ON repositories(tenant_id, owner, name);
