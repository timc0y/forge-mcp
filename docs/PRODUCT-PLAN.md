# Forge Cloud Product Plan

## Product Promise
> Connect a repository, run the product, inspect phone and desktop evidence, fix bugs, and open a pull request without checking out the repository in the AI host.

*   **Parallax**: Review system. Owns audiences, missions, environments, findings, and verification.
*   **Forge**: Execution layer. Owns repository access, Linux execution, workspaces, previews, browser capture, artifacts, Git side-effects, and cleanup.
*   **Non-Goals**: Forge is not an autonomous agent, not a cloud IDE, and not a general-purpose CI.

## Deployment Options

*   **Forge Cloud (Hosted)**: GitHub App installation. MCP server connection. Auto-managed workspace lifecycles.
*   **Self-Managed (Open Source)**: Hosted on user's Cloudflare & GitHub accounts. User manages secrets, costs, and resources. Browser rendering agent runs on user compute; never receives code checkouts.

## User Journey
1. Sign in -> Install GitHub App -> Connect MCP in chat client.
2. Request Parallax review on target repo.
3. Forge creates lightweight, executor-free workspace session on branch `forge/*`.
4. Forge reads parallax contract and instructions.
5. Apply edits via `forge_edit` (commits directly to GitHub).
6. First runtime check allocates an ephemeral sandbox container to build and run the app.
7. Capture viewports and accessibility tree; output returned to model as image artifacts.
8. Model files findings. Verification contract executed.
9. PR opened; return approval link to human. Workspace destroyed.

## KISS Product Rules
1. One workspace = one GitHub branch session with at most one active executor-backed service.
2. Single-writer mutation model; concurrent reads allowed.
3. Private clone credentials are short-lived, injected only for system clone, and never exposed to shell.
4. Screenshots returned as MCP image contents and stored in R2.
5. Limit interactions report failure instead of pretending success.
6. Ephemeral sandboxes stop after 10 minutes idle; hard lifetime limits apply.

## Public Tool Surface

| Group | Tools | Behavior |
| :--- | :--- | :--- |
| **Workspace & Context** | `forge_workspace_create`, `forge_workspace_get`, `forge_context_get`, `forge_workspace_destroy` | Create/inspect/destroy sessions. Container-free. |
| **Repository Files** | `forge_files_read`, `forge_files_list`, `forge_edit`, `forge_diff_metadata`, `forge_context_get` | Reads and edits using GitHub Git Data API. No executor allocated. |
| **Execution** | `forge_shell`, `forge_process_list`, `forge_process_wait`, `forge_process_logs`, `forge_process_stop`, `forge_deps_install`, `forge_deploy` | ephemeral executor allocated. File mutations remain local; push commands blocked. |
| **Review Evidence** | `forge_preview_expose`, `forge_review`, `forge_preview`, `forge_artifact_get` | Previews and artifact uploads. Static review uses no compute. |
| **GitHub Review** | `forge_start`, `forge_history`, `forge_branches`, `forge_pr`, `forge_merge` | Git operations via GitHub API. `forge_merge` requires human approval. |

## Parallax Evidence Contract
Forge outputs evidence in the following format:
```json
{
  "schemaVersion": 1,
  "provider": "forge",
  "workspaceId": "ws_...",
  "repository": "owner/repo",
  "commit": "...",
  "workspaceRevision": 7,
  "capturedAt": "...",
  "evidence": [
    {
      "selection": "page:pricing",
      "route": "/pricing",
      "environment": "phone",
      "state": "entry",
      "requestedViewport": { "width": 390, "height": 844 },
      "observedViewport": { "width": 390, "height": 844 },
      "screenshot": {
        "artifactId": "art_...",
        "contentType": "image/png",
        "sha256": "..."
      },
      "accessibility": { "tree": {}, "truncated": false },
      "limitations": []
    }
  ]
}
```

## Architecture
```
Client (ChatGPT/Claude/Parallax)
  │ OAuth 2.1 / HTTP MCP
  ▼
Edge Worker (Auth, MCP, Policy, Previews) ──► R2 / Browser Run
  │
  ▼
Workspace Coordinator DO (Session/Process State)
  │ Allocates sandbox
  ▼
Cloudflare Sandbox (Shell, Build, Test, Preview, Deploy)
```

## Hosted Tenancy & Security
*   **Auth Chain**: Subject -> Tenant -> Project -> Workspace -> Repository Auth -> Action Policy -> Approval.
*   **OAuth**: PKCE S256, access JWT (1h TTL), rotating refresh JWT (30d TTL). HS256 signed.
*   **GitHub Security**: Installation tokens proxy-held. Force pushes blocked. Commit scanning for secrets. Draft PRs require human approval.

## Resource & Cost Controls
*   **Limits**: 1 active workspace per free user, 3 per paid user. 10m idle timeout. 45m hard lifetime.
*   **Artifacts**: 7-day R2 retention (free), 30-day (paid).
*   **Buyable Credits**:
    *   *Self-Managed*: Free software; operator pays Cloudflare/GitHub costs.
    *   *Cloud Trial*: Free; 3 credits, public repos, 7-day R2.
    *   *Cloud Pro* (£29/mo): 30 credits, private repos, PR handoff, 30-day R2.
    *   *Cloud Team* (£99/mo): 150 shared credits, 5 seats, audit history.

## Product Surfaces
*   **Marketing**: Highlights run-and-PR demo.
*   **Console**: Minimal. Interface is `/approvals/:id` for human confirmation.
*   **Parallax**: Imports Forge evidence envelope and evaluates verification rules.

## Delivery Requirements & Acceptance Test
*   **Ready Checklist**: Wrangler self-host docs complete, edge Worker active, OAuth flow active, lazy container materialization, Vite/Astro project compatibility, private preview routing, Git push blocks, automatic cleanup.
*   **Acceptance Test**:
    1. Connect Forge.
    2. Request Parallax review.
    3. Verify workspace is container-free until checks run.
    4. View screenshots in chat.
    5. Apply `forge_edit` to GitHub branch.
    6. Run verification.
    7. Approve draft PR, confirm links.
    8. Destroy workspace, verify preview URLs are dead.
