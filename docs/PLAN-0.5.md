# Forge MCP 0.5 plan

## Product decision

Forge MCP 0.5 is a Parallax-first remote execution layer, not a separate coding agent.

The public promise is:

> Run Parallax Review from ChatGPT, Codex or Claude against a real GitHub repository, with the repository, terminal, browser evidence, Git branch and pull request handled remotely.

The external agent supplies reasoning. Forge supplies the computer and controlled side effects. Parallax remains the source of truth for review contracts, missions, environments, evidence and final review semantics.

Forge should support two deployment modes with one contract:

1. **Self-hosted Forge:** the user deploys Forge into their own Cloudflare account and pays Cloudflare directly.
2. **Forge Cloud:** Forge operates the Cloudflare resources, and the user pays Forge for a hosted allowance plus usage.

Local Parallax remains available and unchanged. Forge is the remote mode for clients that do not have the repository, terminal or browser available in the conversation.

## The 0.5 user journey

```text
Connect GitHub repository
        ↓
ChatGPT connects to Forge MCP
        ↓
Forge creates an isolated workspace
        ↓
Parallax contract is loaded from the repository
        ↓
Agent reads, edits, builds and tests
        ↓
Forge starts a preview and captures browser evidence
        ↓
Parallax review packet is returned to the agent
        ↓
Agent explains findings and proposes or applies changes
        ↓
Forge creates a branch, commit and draft PR
        ↓
Workspace and preview are destroyed
```

The first meaningful acceptance test is: an external MCP client can take a private GitHub repository from review request to screenshot-backed draft pull request without a local checkout.

## Scope

### Required in 0.5

- GitHub App installation and repository authorization.
- Workspace creation from a repository, ref and optional working directory.
- Bounded file tree, search, read and patch operations.
- Foreground commands, background processes and bounded logs.
- Build/test execution inside an on-demand Cloudflare Sandbox.
- Preview exposure and browser screenshots/accessibility evidence.
- Parallax contract loading from `parallax/`.
- Parallax-compatible run packet, artifact manifest and limitation reporting.
- Git status, diff, branch creation, commit and push.
- Draft pull request creation with test and visual evidence links.
- Explicit approval for push, PR creation and other external side effects.
- Workspace destruction, preview revocation and capability revocation.
- Native Parallax access through a Service Binding/RPC adapter.
- Remote MCP access for ChatGPT, Codex, Claude and other compatible clients.

### Deferred

- Always-on workspaces.
- Multi-agent workspace fleets.
- Workers for Platforms as a required dependency.
- A full IDE or terminal UI.
- Autonomous merging or direct default-branch pushes.
- Semantic repository embeddings.
- Artifacts as the only repository store while it remains closed beta.
- Dynamic Workers/Code Mode as the execution layer. They may later reduce tool-context cost, but they do not replace Linux execution.

## Technical shape

```text
MCP client ───────────────┐
                          ▼
                  Forge Edge Worker
                  auth · MCP · policy
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
   Workspace DO       GitHub App        Parallax RPC
   revision/leases    clone/PR auth     same service layer
          │
          ▼
   Cloudflare Sandbox
   files · shell · build · preview
          │                    │
          ▼                    ▼
     Browser Run              R2
     screenshots              evidence/logs
```

Keep the control plane provider-neutral. The Cloudflare Sandbox implementation remains behind `SandboxProvider`. A workspace is created lazily and uses the smallest suitable instance profile; the default is short idle sleep and a hard lifetime. The full workspace is not kept warm between reviews.

For the cheapest stateless operations, prefer a stateless MCP handler. Use one Workspace Coordinator Durable Object for active workspace state rather than a Durable Object for every lightweight tool call. D1 and Workflows are optional infrastructure for hosted scale and long-running lifecycle operations, not prerequisites for the first self-hosted deployment.

## Parallax contract

Forge must not invent a second review format. The adapter should consume and return Parallax-shaped data:

- project, audiences, surfaces, missions and review configuration are read from the repository;
- target selection preserves `affected`, page, component, mission and ad-hoc semantics;
- environments preserve viewport, locale, color scheme and reduced-motion settings;
- each screenshot records route, environment, state, dimensions, source, hash and inspection status;
- source-only, artifact-only and unavailable browser paths remain explicit limitations;
- the agent receives the packet and evidence, then performs the product judgement.

The Parallax repository should gain a small remote adapter rather than a second product contract: a remote run can be imported, verified and finalized using the same evidence and report rules as a local run.

## Deployment modes

### Self-hosted

Public repository, one-click Cloudflare deployment and a documented manual deployment path.

The user supplies:

- a Cloudflare account;
- GitHub App credentials or installs the Forge GitHub App;
- R2/Browser/Sandbox resources created by Wrangler;
- OAuth and preview-domain configuration.

The self-hosted distribution should make the cost boundary clear: Forge software is free/open source; Cloudflare compute, browser usage, storage and GitHub limits belong to the user.

### Forge Cloud

Forge operates a shared multi-tenant control plane and isolated workspaces.

The hosted path adds:

- Forge account authentication;
- tenant and project records;
- per-tenant GitHub App installation mapping;
- workspace concurrency and time quotas;
- usage metering by active workspace time, browser time and retained artifacts;
- Stripe Checkout/subscriptions or credits;
- tenant-scoped audit and deletion controls;
- hosted MCP endpoint and public documentation.

Do not set public prices until representative runs produce a cost model. Start with a small free allowance, then charge for predictable review credits rather than exposing raw Cloudflare billing dimensions.

Both modes must use the same MCP schemas, Parallax adapter and policy decisions. Only the resource provider and billing layer differ.

## Public presentation

The public site and README should lead with the Parallax use case:

### Headline

**Run Parallax Review from any AI coding client.**

### Explanation

Forge MCP gives ChatGPT, Codex and Claude a disposable, review-ready development workspace connected to GitHub. It can inspect code, run the project, capture browser evidence, and prepare a pull request while Parallax preserves the review contract and evidence discipline.

### Three visible paths

1. **Use Forge Cloud** — connect GitHub and add Forge as a remote MCP server.
2. **Deploy your own Forge** — one-click Cloudflare deployment; you pay your own Cloudflare bill.
3. **Use local Parallax** — no Forge account, for projects already available to the host app.

The demo should show one complete path: connect repository → select mission → run preview → inspect phone and desktop screenshots → identify a finding → apply a patch → run checks → open draft PR.

The public repository should include the architecture, threat model, cost model, self-hosting guide, hosted-service boundary, and a clear statement of what is not yet production-ready.

## Delivery sequence

### 0.5.0 — contract and public foundation

- Publish the Parallax-first product definition and architecture.
- Add the remote run and evidence schemas.
- Separate control-plane interfaces from Cloudflare adapters.
- Keep the existing local Parallax workflow working.

### 0.5.1 — self-hosted review beta

- Private GitHub clone through an installation capability.
- Read/search/patch/build/test/preview/screenshot flow.
- Parallax packet returned to an MCP client.
- One-click Cloudflare deployment and documented secrets.
- No billing and no direct default-branch writes.

### 0.5.2 — coding and PR completion

- Branch, commit, push and draft PR tools.
- Approval records and evidence attached to PRs.
- Native Parallax Service Binding/RPC path.
- Cleanup and reconciliation for failed or abandoned workspaces.

### 0.5.3 — hosted beta

- Hosted MCP endpoint.
- Tenant isolation and quotas.
- GitHub App installation UI.
- Usage metering and billing experiments.
- Public demo, onboarding and support/runbook.

## Definition of done

Forge 0.5 is ready to show publicly when:

1. A user can choose self-hosted or Forge Cloud without changing the MCP contract.
2. ChatGPT can connect to Forge MCP and identify the repository and Parallax contract.
3. Forge can run a real review against a private repository and an approved preview.
4. The agent receives screenshots with complete evidence metadata.
5. The agent can make a bounded change, run validation and inspect the diff.
6. Forge can create a non-default branch and draft PR only after approval.
7. The workspace, preview and Git capability are revoked after teardown.
8. Local Parallax remains a first-class path, not a forced dependency on Forge Cloud.

## Principal risks

- Sandbox and related Cloudflare APIs are moving quickly; keep them behind adapters and pin versions.
- Every workspace operation must verify tenant, project, repository and current authorization, not only the workspace ID.
- GitHub installation tokens must never enter the sandbox or model output.
- Egress, output limits, idle shutdown and per-tenant quotas are cost and security controls, not optional polish.
- Hosted billing and multi-tenancy should follow a successful self-hosted review flow, not precede it.
