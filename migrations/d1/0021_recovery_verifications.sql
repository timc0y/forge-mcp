CREATE TABLE IF NOT EXISTS service_verifications (
  name TEXT PRIMARY KEY,
  verified_at TEXT NOT NULL,
  evidence TEXT NOT NULL
);
