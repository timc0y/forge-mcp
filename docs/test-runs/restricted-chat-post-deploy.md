# Production restricted-chat regression

This disposable branch tests Forge from an ordinary ChatGPT-style client that may stop after any tool call and cannot retain private workspace, process, task, preview, or operation IDs.

## Setup

- Repository: timc0y/forge-mcp
- Base: main
- Production MCP: https://forge.timcoy.uk/mcp
- Production Worker version: 738cfccc-eb65-4504-8109-7f537951e986
- Fixture preview: forge.json -> apps/fixture-catalog, port 4321

## Acceptance checks

- GitHub reads and edits return durable branch/commit evidence.
- forge_run absorbs private executor startup or returns a safe action-level error.
- forge_screenshot starts the configured local dev server and returns inline responsive evidence.
- No response requires a private lifecycle ID or a follow-up artifact retrieval call.
- The branch remains disposable and is submitted only after its contents are verified.

## Final trace

- forge_repositories: pass; 24 authorized repositories, including timc0y/forge-mcp.
- forge_search: pass; found the configured preview documentation and fixture config on GitHub.
- forge_read: pass; returned authoritative docs, forge.json, and branch commit content.
- forge_edit: pass after one observed GitHub read-after-write 404; branch-addressed recovery committed the document remotely. A later fresh branch edit passed on the first call after the read-back retry fix.
- forge_run: the cold call returned a bounded action-level startup receipt with no private IDs; the same branch retry completed with exit 0 and stdout evidence. The final response exposed no operation/workspace IDs or private tool names.
- forge_screenshot: cold calls returned the same bounded startup receipt; the warm same-branch call captured phone, tablet, and desktop screenshots inline (3/3, no omitted captures or artifact follow-up).
- forge_environments: pass; returned an empty environment list without secrets.
- forge_deploy: failed closed as expected because no approved production environment is configured.
- forge_submit: pass; returned a durable deferred human-approval receipt for the verified branch commit.
- forge_status: pass after the status fix; the submitted branch now recovers as approval_required by repository/ref and returns its approval URL instead of the older command status.

No private workspace, process, task, preview, approval, or operation identifier was copied into this document. Signed URLs were intentionally not persisted.
