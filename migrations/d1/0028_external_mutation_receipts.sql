CREATE TABLE IF NOT EXISTS external_mutation_receipts (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  completed_at TEXT,
  receipt_json TEXT,
  PRIMARY KEY (tenant_id, scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_external_mutation_receipts_completed
  ON external_mutation_receipts(completed_at);
