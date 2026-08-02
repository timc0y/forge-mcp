# Forge Cloud product plan

## Product promise

Forge gives ChatGPT, Codex and Claude a real development computer for Parallax Review.

> Connect a repository, run the product, inspect phone and desktop evidence, fix what matters, and open a reviewable pull request without checking the repository out in the AI host.

Parallax remains the review system. It owns audiences, missions, environments, readiness, specialists, evidence semantics, findings and exact verification. Forge owns repository access, Linux execution, processes, previews, browser capture, artifacts, Git side effects and teardown.

The product is deliberately narrow:

- Forge is not an AI agent.
- Forge is not a cloud IDE.
- Forge is not general-purpose CI.
- Forge never merges or writes to the default branch.
- Forge does not invent a second review format beside Parallax.

## The product users buy

### Forge Cloud — hosted product

For a user who wants the workflow to work without a local checkout or Cloudflare setup.

- Sign in, install the Forge GitHub App and select repositories.
- Add Forge as a ChatGPT app or remote MCP server.
- Ask for a Parallax review in ordinary language.
- Receive screenshots, accessibility evidence, logs, diff and a draft PR.
- Workspaces stop automatically and retained evidence expires by policy.

### Self-managed Forge — open source

For a team that wants the same service in its own Cloudflare and GitHub accounts.

- The same Worker, MCP tools and Parallax adapter as Forge Cloud.
- The user owns Cloudflare, GitHub App, domains, secrets, quotas and costs.
- GitHub remains the sole durable repository CRUD plane.
- Cloudflare Sandbox remains the only command execution plane.
- The optional self-hosted component renders browser evidence only; it never
  receives a repository checkout or runs agent shell commands.

Local development runs the Worker and its Cloudflare Sandbox integration for
testing. There is no separate local-filesystem CRUD edition.

## One user journey

```text
Sign in to Forge
  → install GitHub App on selected repositories
  → connect Forge MCP in ChatGPT, Codex or Claude
  → ask “Run Parallax Review on owner/repo, mission:checkout”
  → Forge creates a lightweight workspace session on a GitHub forge/* branch
  → Forge reads the repository’s parallax/ contract and instructions from GitHub
  → forge_edit commits any wanted source change directly to GitHub
  → the first runtime check allocates an ephemeral executor
  → Forge installs dependencies and starts one web service in that executor
  → Forge captures the required routes, states and viewports
  → the model receives inspectable images and accessibility evidence
  → Parallax applies readiness and review rules
  → the model reports findings or applies a bounded forge_edit
  → Forge runs the stored verification contract
  → Forge opens a draft PR and returns the human approval link
  → Forge attaches evidence and destroys the workspace
```

The first public demo must show this whole journey. Separate architecture demos do not count.

## KISS product rules

1. One workspace is one GitHub branch session with at most one active executor-backed web service.
2. One workspace has one mutation owner; reads may remain concurrent.
3. Public repositories work before private repositories are enabled.
4. Private clone credentials are short-lived, injected only into the system clone,
   removed immediately afterward, and never returned to agent commands.
5. A review uses repository-declared setup when present and conservative detection otherwise.
6. One MCP tool captures a bounded Parallax evidence packet; individual browser tools remain available for follow-up.
7. Screenshots are returned as MCP image content and stored in R2 with hashes.
8. Forge records limitations instead of converting unavailable interaction into a pass.
9. Every external side effect is explicit, attributable and approval-gated.
10. Executors are absent by default, stop after ten idle minutes and have a hard lifetime.

## Public tool surface

Keep the default catalog compact. The model should not need provider-specific tools.

### Workspace and context

- `forge_workspace_create`
- `forge_workspace_get`
- `forge_context_get`
- `forge_workspace_destroy`

### Repository files

- `forge_files_read`
- `forge_files_list`
- `forge_edit`
- `forge_diff_metadata`
- `forge_context_get`

These tools use the GitHub API and never allocate or inspect an executor. `forge_edit`
is the only public file writer/deleter and commits directly to the selected branch.

### Execution

- `forge_shell`
- `forge_process_list`
- `forge_process_wait`
- `forge_process_logs`
- `forge_process_stop`
- `forge_deps_install`
- `forge_deploy`

Execution tools allocate a Cloudflare Sandbox lazily. Their filesystem effects
remain ephemeral and are never imported into GitHub; wanted changes must be
recreated explicitly with `forge_edit`. `forge_deploy` selects a provider
workflow from attached vault environment-variable names (Cloudflare Wrangler
today) rather than requiring a provider-specific tool.

### Review evidence

- `forge_preview_expose`
- `forge_review`
- `forge_preview`
- `forge_artifact_get`

`forge_review` captures a bounded evidence packet from an already deployed URL
without an executor. `forge_preview` captures the equivalent bounded routes,
states, and viewports from an executor-backed development service.

### GitHub review

- `forge_start`
- `forge_history`
- `forge_branches`
- `forge_pr`
- `forge_merge`

Branch, commit, history, diff, and PR operations use GitHub directly. There is
no public commit/push pipeline: `forge_edit` creates guarded commits and
`forge_merge` opens the human review flow.

## Parallax contract

Forge consumes these tracked repository files without changing their meaning:

```text
parallax/project.json
parallax/audiences.json
parallax/surfaces.json
parallax/review.json
parallax/missions/*.json
```

Forge returns remote evidence in a portable envelope:

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

Parallax imports this as artifact evidence. A remote screenshot can support visual judgement after inspection. It cannot by itself prove a multi-step interaction; missions that require interaction remain partial until the agent executes and records the steps.

## Architecture

```text
ChatGPT / Codex / Claude / Parallax
                  │
                  │ OAuth 2.1 + Streamable HTTP MCP
                  ▼
          Forge Edge Worker
       auth · MCP · policy · preview
          │            │          │
          │            │          └── Browser Run evidence
          │            └───────────── R2 artifacts
          ├────────────────────────── GitHub API
          ▼
   Workspace Coordinator DO
   identity · revision · process state
          │ allocate on first execution
          ▼
     Cloudflare Sandbox
 shell · install · build · test · service · deploy
```

Cloudflare implementation details stay behind provider contracts. Self-managed
Forge deploys the same Worker and Sandbox integration in the operator's account;
there is no local-filesystem repository adapter.

## Hosted tenancy

Every request resolves this authorization chain before touching a workspace:

```text
authenticated subject
  → active tenant membership
  → project membership
  → workspace tenant/project match
  → current repository authorization
  → action policy
  → approval when required
```

Workspace IDs are not authorization. Every handler verifies tenant and project ownership. Repository access is rechecked for GitHub reads, edits, branch operations, executor materialization, and PR operations.

## Authentication

Self-hosted and the private Forge Cloud pilot use a single-owner OAuth approval flow:

- dynamic client registration;
- Authorization Code with PKCE S256;
- short-lived access tokens;
- rotating refresh tokens;
- exact redirect URI validation;
- owner token entered only on the Forge approval page.

Public Forge Cloud replaces owner-token identity with product accounts while preserving the same OAuth/MCP contract.

## GitHub security

- Public clone is anonymous.
- Private clone, fetch and push use the GitHub App.
- Installation tokens remain in the credential proxy.
- The sandbox receives a short-lived Forge capability restricted to workspace, repository, operation, branch pattern, expiry and nonce.
- Default-branch push and force push are blocked.
- Outgoing commits are scanned for known secret patterns and prohibited files.
- PR creation records the exact outgoing commit range, checks, screenshots and Forge operation IDs.

## Runtime and cost controls

The hosted default is the smallest container profile that can complete a representative JavaScript build. Start with `basic`; allow a repository to request `standard-1` only when the smaller profile fails with a recorded resource reason.

- Maximum one active workspace per free user.
- Maximum three active workspaces per paid individual account.
- Ten-minute idle timeout.
- Forty-five-minute hard lifetime.
- One active preview per workspace.
- Browser evidence uses a private, header-scoped Worker-to-Sandbox bridge; no raw provider URL is created or returned.
- Eight screenshots in a standard review packet.
- R2 evidence expiry: seven days free, thirty days paid.
- No always-on containers.
- Executors materialize a fresh checkout from GitHub when allocated or recovered;
  Forge does not persist executor snapshots or dependency trees.

Workers, Durable Objects and D1 stay near-zero while idle. Container and browser time are the billable dimensions and must be metered per operation.

## Buyable packaging

Pricing is expressed in review credits so customers do not need to understand Cloudflare billing.

One standard review credit includes:

- one workspace up to ten active minutes;
- one dependency restore/install;
- one running web service;
- up to eight screenshots;
- accessibility capture;
- one test command;
- one retained evidence packet.

Initial pricing to validate willingness to pay:

| Offer | Price | Included |
| --- | ---: | --- |
| Self-managed Forge | Free software | User pays Cloudflare and GitHub costs |
| Forge Cloud Trial | Free | 3 review credits, public repositories, 7-day evidence |
| Forge Cloud Pro | £29/month | 30 review credits, private repositories, PR handoff, 30-day evidence |
| Forge Cloud Team | £99/month | 150 shared credits, 5 members, audit history and repository policy |

Extra credits should be sold as a predictable pack only after representative runs confirm gross margin. Prices are launch hypotheses, not promises embedded in runtime code.

## Product surfaces

### Marketing page

Headline:

> Run Parallax Review from any AI coding client.

Subheading:

> Forge gives ChatGPT, Codex and Claude an isolated repository, terminal and browser. Parallax tells them what to review and what counts as evidence.

Primary actions:

- Try Forge Cloud
- Deploy to Cloudflare
- Self-manage Forge

The page shows the complete repository-to-PR demo and clearly labels current limits.

### Forge Console

Not built, and not planned as an in-chat widget. An MCP Apps in-chat widget
version was shipped and then removed: it rendered unreliably across hosts, and
where it did render it wrapped a lot of chrome around information the model was
already stating in chat.

Workspace, evidence, diff and test state stay available as structured MCP
output. The only Forge-authored screen is the approval page at
`/approvals/:id`. If a console returns, it should be a web surface under
`/app`, not something injected into the chat transcript.

### Parallax

Parallax adds `forge` as an execution provider while retaining `live`, `artifact` and `source` evidence channels. It can:

- generate a run packet locally;
- hand routes/viewports/states to Forge;
- import the Forge evidence packet;
- preserve remote artifact IDs and hashes;
- finalize with the same readiness and finding rules;
- repeat the exact contract for verification.

## Operational contract

- `/health` confirms Worker availability only.
- `/ready` verifies D1, R2 and configuration without starting a sandbox.
- a synthetic public-repository review verifies the complete path on deployment and on a schedule;
- logs redact bearer tokens, preview capabilities, authorization headers and known secrets;
- every operation has a trace ID and workspace revision;
- failed provisioning destroys partial runtime resources;
- workspace destruction revokes preview and Git capabilities before deleting runtime state;
- incident response can disable workspace creation while leaving artifact retrieval available.

## What ships together

The product is ready only when all of these are true in one release:

- Self-managed Forge can be deployed from documented Wrangler configuration.
- Forge Cloud is deployed on the `tims` Cloudflare account as a private pilot.
- ChatGPT can discover OAuth and the MCP tool catalog.
- A public repository can be read through GitHub without compute and materialized
  into an on-demand Sandbox only for execution.
- A representative Vite or Astro project installs and starts.
- Forge returns a private preview.
- `forge_review` and `forge_preview` produce bounded phone and desktop evidence.
- `forge_artifact_get` returns each screenshot as MCP image content.
- Parallax imports the packet and preserves evidence metadata and limitations.
- The model can commit an edit through `forge_edit`, run a test in the executor,
  and inspect the GitHub diff.
- Private GitHub access uses a GitHub App without exposing installation tokens.
- Raw executor pushes are blocked; draft PR creation enters the human approval flow.
- Teardown revokes previews, capabilities and runtime.
- The public docs explain hosted and self-managed choices without overstating readiness.

## Acceptance test

Use one public demo repository and one private test repository. From a clean ChatGPT conversation:

1. Connect Forge.
2. Request a configured Parallax page or mission review.
3. Observe the lightweight workspace session remain executor-free until a runtime
   check is requested.
4. Inspect two returned screenshot images directly in the conversation.
5. Receive a Parallax report with evidence-linked findings or an honest no-findings result.
6. Apply one bounded `forge_edit` commit to the GitHub branch.
7. Run the stored verification contract.
8. Approve a draft PR for the private repository.
9. Confirm the PR contains test and evidence links.
10. Destroy the workspace and confirm its preview no longer resolves.

No partial architecture demonstration substitutes for this acceptance test.
