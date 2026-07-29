# Forge system architecture

Forge separates intelligence from execution. MCP clients choose actions; Forge authenticates, authorizes, coordinates, executes, records evidence, and exposes stable results.

```mermaid
flowchart TD
  C[ChatGPT / Codex / Claude / OpenCode / Parallax / custom clients]
  G[Forge Edge Gateway\nOAuth resource server + MCP Streamable HTTP + REST + webhooks]
  M[MCP Session Agent\nprotocol state and client capabilities]
  W[Workspace Coordinator DO\nrevision, leases, processes, previews, approvals]
  WF[Cloudflare Workflows\nprovision and destroy]
  A[Forge Application Service\nprovider-neutral use cases]
  S[SandboxProvider]
  CS[Cloudflare Sandbox SDK]
  B[BrowserProvider]
  BR[Cloudflare Browser Run]
  GH[GitProvider + credential proxy]
  R[(R2 artifacts)]
  D[(D1 metadata)]
  C -->|OAuth 2.1 + MCP| G
  G --> M
  M --> W
  M --> WF
  WF --> W
  W --> A
  A --> S --> CS
  A --> B --> BR
  A --> GH
  A --> R
  W --> D
```

## Durable boundaries

- **MCP Session Agent:** protocol state, client capabilities, request correlation and subscriptions. One session may use several workspaces.
- **Workspace Coordinator:** one object per workspace, monotonic revision, idempotency, lease state, mutation serialization, processes, previews and reconciliation to D1.
- **Workflow:** durable provisioning/destruction orchestration. It invokes the coordinator rather than owning live workspace state.
- **Application service:** provider-neutral use cases and stable Forge errors.
- **Providers:** Cloudflare Sandbox, Browser Run, R2, D1 and later GitHub are adapters; their identifiers do not cross the public MCP contract.

## Trust boundaries

1. The client is untrusted input, even after authentication.
2. Repository content and every command it can trigger are hostile.
3. The sandbox is an execution boundary, not an authorization authority.
4. The application layer owns policy and never exposes provider identifiers as the public contract.
5. External side effects require fresh authorization at execution time.

## Implemented vertical slice

The current private pilot implements GitHub-backed identity and installation
repository synchronization, deterministic task/workspace records, durable
provisioning and destruction workflows, remote-first GitHub file reads and
guarded edits, bounded shell commands and managed processes, snapshots and
restore, live observer views, branch/history/access inspection, PR readiness
and merge actions, private previews, Browser Run evidence, encrypted secret
attachments, and verified Cloudflare deployment receipts.

Repository changes are committed directly through the GitHub API and verified
by ref read-back. The sandbox remains responsible for execution and preview
state; it is not the repository durability authority.
