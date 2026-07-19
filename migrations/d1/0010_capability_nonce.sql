-- Single-use store for capability-token nonces (replay protection).
-- The first claim of a nonce inserts a row; any later claim conflicts on the
-- PRIMARY KEY and is rejected, so a captured capability token cannot be reused.
CREATE TABLE IF NOT EXISTS capability_nonces (
  nonce TEXT PRIMARY KEY,
  action TEXT,
  expires_at TEXT,
  seen_at TEXT NOT NULL
);

-- Supports pruning of expired nonces.
CREATE INDEX IF NOT EXISTS idx_capability_nonces_expires_at
  ON capability_nonces(expires_at);
