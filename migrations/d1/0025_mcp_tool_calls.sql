PRAGMA foreign_keys = ON;

-- What agents actually send and get back, one row per MCP tool call.
--
-- workspace_activity records that a call happened and whether it failed. That
-- is enough to count errors and nothing like enough to fix them: every real
-- failure this system has had was about the *content* of a call — an argument
-- the agent could not have known to send, a response it misread, a message
-- that named a tool which no longer existed. Without the payloads those are
-- invisible until a human reproduces them by hand.
--
-- Payloads are redacted and bounded before they land here, so this is a
-- debugging trail, not an archive: secret values never arrive, and large file
-- content is stored as a preview plus its true size.
CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  workspace_id TEXT,
  client_name TEXT,
  tool TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  error_message TEXT,
  request_json TEXT,
  response_json TEXT,
  request_bytes INTEGER,
  response_bytes INTEGER,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_tenant_time
  ON mcp_tool_calls(tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_workspace_time
  ON mcp_tool_calls(workspace_id, occurred_at DESC);

-- Error triage: "what is failing right now, and what were they sending".
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_status_time
  ON mcp_tool_calls(tenant_id, status, occurred_at DESC);
