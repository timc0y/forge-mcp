PRAGMA foreign_keys = ON;

-- A bounded, human-authorized envelope that lets forge_git_push auto-satisfy
-- (skip the per-push human click) for a run of small commits within one task,
-- WITHOUT becoming a blanket auto-approve. One human approval (via the normal
-- signed approval-link flow) creates the row; every push against it is still
-- checked against the invariant at push time — fast-forward only (no rewritten
-- history), fixed branch/base, and every changed path a subset of
-- allowed_paths. Any push that fails the check falls back to a normal,
-- individually-approved push. Revocable and expiring; never covers
-- pull_request.create, which stays gated on every call.
CREATE TABLE IF NOT EXISTS push_envelopes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  -- JSON array of path prefixes the envelope covers. A push whose changed
  -- files are not all covered by one of these prefixes falls back to a
  -- normal human-approved push.
  allowed_paths TEXT NOT NULL,
  -- Commit the envelope was authorized against. Each covered push must be a
  -- fast-forward descendant of this commit; updated to the new HEAD after
  -- every push that uses the envelope.
  last_approved_commit TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_envelopes_lookup
  ON push_envelopes(tenant_id, workspace_id, branch, base, expires_at);
