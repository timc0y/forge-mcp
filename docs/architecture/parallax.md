# Parallax integration

Parallax is Forge's first-party client, not the execution platform. It can use either the public MCP contract or a Cloudflare service binding into the same application services.

Parallax owns review semantics and requires inspected screenshot evidence. Forge is one evidence provider alongside the host's built-in browser, Chrome and repository Playwright. `forge_review` captures deployed URLs without an executor; repository builds allocate an ephemeral executor only when source must be installed, built, tested or served. Repository edits still go through `forge_edit` and GitHub.

The native path may optimize identity propagation, event delivery, preview embedding and approvals, but cannot duplicate policy or workspace logic. Parallax receives workspace-scoped Forge capabilities, never GitHub installation tokens, executor-provider credentials or unrestricted internal bindings.
