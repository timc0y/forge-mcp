-- Track whether a workspace has local work that hasn't been pushed (a forge
-- branch, a commit, an applied patch or file write). The idle reaper reads this
-- to refuse destroying a workspace with unpushed work, so an agent's in-flight
-- work is never silently lost when a stranger's create call triggers reclaim.
ALTER TABLE workspaces ADD COLUMN has_unpushed_work INTEGER NOT NULL DEFAULT 0;
