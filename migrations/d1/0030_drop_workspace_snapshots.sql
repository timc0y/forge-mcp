-- Full-workspace executor snapshots are intentionally gone: GitHub is the
-- durable source and executor files are ephemeral. Keep applied history intact
-- and remove only the obsolete index table on upgraded databases.
DROP TABLE IF EXISTS workspace_snapshots;
