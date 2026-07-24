-- Deferred actions: work an agent has finished and staged, waiting on a human.
--
-- The approval model used to be synchronous — a tool threw FORGE_APPROVAL_REQUIRED
-- and the agent had to still be alive to redeem the approval afterwards, so a push
-- or a PR could only happen while someone was watching. A deferred action inverts
-- that: the agent stages its commits on a Forge-owned ref, records what it wants
-- done here, and finishes. Whenever the human gets round to approving, Forge
-- performs the push and opens the PR itself, with no agent and no workspace
-- required.
CREATE TABLE IF NOT EXISTS deferred_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  -- The approval whose resolution releases this action.
  approval_id TEXT NOT NULL,
  task_id TEXT,
  action TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  -- Branch the human is approving into, and the base it targets.
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  -- Forge-owned ref holding the commits until approval, and the exact commit it
  -- points at. Replaying that commit onto `branch` is the whole of the push.
  staged_ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  files_changed INTEGER NOT NULL DEFAULT 0,
  -- awaiting_approval | executing | completed | failed | denied | expired
  state TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One deferred action per approval: approving twice must not open two PRs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deferred_actions_approval ON deferred_actions(approval_id);
-- Drives the portal queue ("what is waiting on me?").
CREATE INDEX IF NOT EXISTS idx_deferred_actions_tenant_state ON deferred_actions(tenant_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_deferred_actions_workspace ON deferred_actions(workspace_id);
