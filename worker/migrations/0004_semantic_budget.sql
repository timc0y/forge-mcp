-- Shared inference admission. No source, query, repository or user identifiers.
CREATE TABLE semantic_usage (
  day TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  unknown INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

-- Anonymous claims bound simultaneous provider requests. Unknown outcomes keep
-- their slot until expiry; their daily attempt is never refunded.
CREATE TABLE semantic_reservations (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX semantic_reservations_expiry ON semantic_reservations(expires_at);
