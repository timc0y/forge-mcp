-- Access control: signing in with GitHub no longer grants use of Forge.
--
-- Until now any GitHub account that completed the login flow got its own tenant
-- and a working MCP session. Access is now something the owner grants: a new
-- sign-in lands in 'pending' and can see only a "request received" page, while
-- the owner sees the request in the portal and approves or declines it.
--
-- Existing users are backfilled to 'approved' — the people already using Forge
-- must not be locked out by the migration that introduces the gate.
ALTER TABLE users ADD COLUMN access_state TEXT NOT NULL DEFAULT 'approved';
-- Set on the first account to sign in, which is the owner, and on anyone the
-- owner promotes. Owners are implicitly approved and are the only accounts that
-- can approve others.
ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN access_note TEXT;
ALTER TABLE users ADD COLUMN access_requested_at TEXT;
ALTER TABLE users ADD COLUMN access_resolved_at TEXT;
ALTER TABLE users ADD COLUMN access_resolved_by TEXT;

CREATE INDEX IF NOT EXISTS idx_users_access_state ON users(access_state, access_requested_at);
