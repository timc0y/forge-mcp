-- Durable recovery metadata for direct-chat deferred merges.
-- A caller retry key reserves one exact merge intent, while retryable tells the
-- portal whether approving the same row is safe or a fresh forge_merge request
-- is required (for example after a stale head or permanent GitHub error).
ALTER TABLE deferred_actions ADD COLUMN idempotency_key TEXT;
ALTER TABLE deferred_actions ADD COLUMN retryable INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deferred_actions_merge_idempotency
  ON deferred_actions(tenant_id, project_id, repo_owner, repo_name, action, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
