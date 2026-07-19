-- Binds each url-review workspace id (minted server-side by forge_review, never
-- tied to a Durable Object) to its owning tenant + project, so forge_artifact_get
-- can authorize the url-review artifact read explicitly instead of inferring
-- authorization from the R2 key shape.
CREATE TABLE IF NOT EXISTS url_review_workspaces (
  workspace_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
