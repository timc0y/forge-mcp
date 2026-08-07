-- Deferred pull-request merges reuse the durable approval/action row so Forge
-- can complete a merge after the ChatGPT turn and without an approval id in
-- model context. Existing work.submit rows keep NULLs in these columns.
ALTER TABLE deferred_actions ADD COLUMN pull_request_number INTEGER;
ALTER TABLE deferred_actions ADD COLUMN merge_method TEXT;

CREATE INDEX IF NOT EXISTS idx_deferred_actions_pull_request
  ON deferred_actions(tenant_id, repo_owner, repo_name, pull_request_number, state);
