# MCP Apps research

- Repository: `modelcontextprotocol/ext-apps`
- Extension: standardized `ui://` resources in sandboxed host frames with host-mediated communication
- Maturity: supported extension with host capability variance
- Decision: **not adopted.** Trialled as `ui://forge/workspace-console`, then removed — inconsistent rendering across hosts, and heavy chrome around information already present in the model's reply
- Current state: no `ui://` resource is registered; no tool carries `_meta.ui` or `openai/outputTemplate`; the `@modelcontextprotocol/ext-apps` dependency is dropped
- Fallback (now the only path): structured MCP results, artifact links, and the hosted approval page at `/approvals/:id`
- Risk: host-specific capability differences and UI metadata evolution
- Verified: 2026-07-25
