-- Forge V1 state. Everything here is identity, permission, or a decision
-- waiting for a human. No repository state: GitHub holds that.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  github_user_id  TEXT NOT NULL UNIQUE,
  github_login    TEXT NOT NULL,
  installation_id TEXT,
  -- Encrypted at rest (AES-GCM, key derived from FORGE_SIGNING_KEY). Held only
  -- so Forge can create a repository on the user's account, which an
  -- installation token cannot do. Revoked by clearing these columns.
  github_token            TEXT,
  github_refresh_token    TEXT,
  github_token_expires_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- OAuth, kept only as long as a token lives.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id),
  expires_at     TEXT NOT NULL,
  used_at        TEXT
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- A merge or a discard, waiting for a hand. `evidence_json` is what the
-- approval page shows, captured when the decision was requested so the human
-- judges what the model actually saw.
CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  act           TEXT NOT NULL CHECK (act IN ('merge', 'discard')),
  repo_owner    TEXT NOT NULL,
  repo_name     TEXT NOT NULL,
  branch        TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
  result_json   TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  resolved_at   TEXT
);

CREATE INDEX IF NOT EXISTS approvals_pending
  ON approvals (user_id, state, expires_at);

-- The only meter. One row per user per UTC day.
CREATE TABLE IF NOT EXISTS capture_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
