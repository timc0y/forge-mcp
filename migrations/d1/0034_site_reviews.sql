PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS site_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  project_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  requested_url TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('queued', 'discovering', 'planning', 'capturing', 'completed', 'failed')),
  planner_source TEXT,
  route_catalog_artifact_id TEXT,
  plan_artifact_id TEXT,
  evidence_artifact_id TEXT,
  gallery_url TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  captured_count INTEGER NOT NULL DEFAULT 0,
  failures_json TEXT NOT NULL DEFAULT '[]',
  limitations_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_site_reviews_lookup
  ON site_reviews(tenant_id, project_id, origin, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_site_reviews_one_active
  ON site_reviews(tenant_id, project_id, origin)
  WHERE state IN ('queued', 'discovering', 'planning', 'capturing');
