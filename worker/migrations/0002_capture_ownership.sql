-- Future captures are mapped to their Forge user so an account deletion can
-- remove the corresponding R2 objects rather than relying only on lifecycle
-- expiry. The source URL and page title stay inside the capture document; D1
-- stores only ownership, object address and retention dates.

CREATE TABLE IF NOT EXISTS captures (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS captures_by_user
  ON captures (user_id, created_at);

CREATE INDEX IF NOT EXISTS captures_by_expiry
  ON captures (expires_at);
