PRAGMA foreign_keys = ON;

-- Identify a call by its arguments, so an agent repeating the *same* failing
-- call can be recognised while it is happening rather than in a later
-- postmortem. A retry storm is not many failures; it is one failure attempted
-- many times, and only the argument hash tells those apart.
ALTER TABLE mcp_tool_calls ADD COLUMN args_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_repeat
  ON mcp_tool_calls(tenant_id, tool, args_hash, occurred_at DESC);
