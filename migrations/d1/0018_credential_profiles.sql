PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS credential_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'unvalidated' CHECK (state IN ('unvalidated', 'valid', 'invalid')),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  last_validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_profiles_active
  ON credential_profiles(tenant_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_credential_profiles_tenant ON credential_profiles(tenant_id, created_at);

ALTER TABLE workspaces ADD COLUMN credential_profile_id TEXT REFERENCES credential_profiles(id);
