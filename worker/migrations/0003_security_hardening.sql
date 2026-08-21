-- Rotating OAuth refresh tokens. Only hashes are stored; the bearer value is
-- returned to the client once and replaced on every successful refresh.

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id),
  client_id  TEXT NOT NULL REFERENCES oauth_clients(client_id),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_refresh_by_user
  ON oauth_refresh_tokens (user_id, created_at);

CREATE INDEX IF NOT EXISTS oauth_refresh_by_family
  ON oauth_refresh_tokens (family_id, created_at);
