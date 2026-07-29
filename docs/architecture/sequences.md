# Forge sequence diagrams

## Workspace provisioning

```mermaid
sequenceDiagram
  participant C as MCP client
  participant M as MCP Session Agent
  participant W as Provision Workflow
  participant D as Workspace Coordinator DO
  participant A as Forge Application Service
  participant S as SandboxProvider

  C->>M: forge_workspace_create(idempotency_key)
  M->>D: initialize(deterministic workspace_id)
  D-->>M: requested + operation_id + revision
  M->>W: create(workflow_id, workspace_id)
  M-->>C: workspace_id + operation_id + provisioning state
  W->>D: provisionInitialized()
  D->>A: provisionWorkspace()
  A->>S: create + clone + detect + bootstrap
  S-->>A: repository runtime
  A->>D: persist state transitions
  D-->>W: ready / failed
```

## Private preview and browser evidence

```mermaid
sequenceDiagram
  participant C as MCP client
  participant M as MCP Session Agent
  participant D as Workspace Coordinator DO
  participant S as SandboxProvider
  participant P as Forge Preview Gateway
  participant B as BrowserProvider
  participant R as R2 ArtifactStore

  C->>M: forge_preview_expose(process, port)
  M->>D: previewExpose()
  D->>S: exposePort()
  S-->>D: provider endpoint
  D-->>M: preview_id + expiry
  M-->>C: Forge URL + scoped capability
  C->>M: forge_preview(preview_id)
  M->>B: screenshot(Forge private URL)
  B->>P: authenticated internal request
  P->>S: proxy request
  B->>R: store PNG + evidence metadata
  B-->>M: artifact reference + hash
```

## Remote edit and review path

```mermaid
sequenceDiagram
  participant A as Agent
  participant F as Forge
  participant GH as GitHub API
  participant U as User approval

  A->>F: forge_edit(workspace, files, idempotency_key)
  F->>GH: read feature ref + required blobs
  F->>F: apply replacements and build commit
  F->>GH: create objects + update expected feature ref
  F->>GH: read feature ref back
  GH-->>F: observed commit SHA
  F-->>A: remote commit URL + verified SHA
  A->>F: forge_merge(workspace)
  F->>GH: open/update review request
  F-->>U: one approval URL
  U-->>F: approve review/merge path
```
