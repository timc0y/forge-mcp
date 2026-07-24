-- On-demand review previews.
--
-- A reviewer approving a staged submission often wants to click through the
-- running app, not just read the diff. Keeping a container warm for every
-- submission would be expensive and would re-couple approval to workspace
-- lifetime — the exact coupling deferred actions exist to break. So the preview
-- is provisioned only when the reviewer asks for one, from the staged commit,
-- and these columns track that lifecycle per submission.
ALTER TABLE deferred_actions ADD COLUMN preview_workspace_id TEXT;
-- none | provisioning | starting | ready | failed
ALTER TABLE deferred_actions ADD COLUMN preview_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE deferred_actions ADD COLUMN preview_id TEXT;
ALTER TABLE deferred_actions ADD COLUMN preview_expires_at TEXT;
ALTER TABLE deferred_actions ADD COLUMN preview_error TEXT;
