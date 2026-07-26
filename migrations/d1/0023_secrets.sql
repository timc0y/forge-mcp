PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  label TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'generic' CHECK (provider IN ('cloudflare', 'shopify', 'generic')),
  encrypted_vars TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'unvalidated' CHECK (state IN ('unvalidated', 'valid', 'invalid')),
  last_validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, label)
);

CREATE TABLE IF NOT EXISTS attached_workspace_secrets (
  workspace_id TEXT NOT NULL,
  secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  attached_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, secret_id)
);

CREATE INDEX IF NOT EXISTS idx_attached_secrets_workspace ON attached_workspace_secrets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_secrets_tenant ON secrets(tenant_id, label);
