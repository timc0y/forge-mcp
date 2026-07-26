-- Pin a queued submission to GitHub's immutable repository id.
--
-- A deferred action stores repo_owner/repo_name so it can push and open a pull
-- request long after the agent and its workspace are gone. But an owner login is
-- mutable: renaming a GitHub account rewrites it on every repository, and a
-- submission sitting in the review queue across that rename would resolve to a
-- repository slug that no longer exists. Recording the numeric id lets execution
-- re-resolve the current owner/name at approval time, with the stored slug as a
-- fallback for rows written before this column existed.
ALTER TABLE deferred_actions ADD COLUMN github_repository_id TEXT;
