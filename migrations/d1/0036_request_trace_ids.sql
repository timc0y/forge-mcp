PRAGMA foreign_keys = ON;

-- Correlate the durable per-tool payload trail with the HTTP request/response
-- logs emitted at Worker ingress/egress. The ID is diagnostic only; it is not
-- an authorization or workflow handle.
ALTER TABLE mcp_tool_calls ADD COLUMN request_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_request_id
  ON mcp_tool_calls(tenant_id, request_id, occurred_at DESC);
