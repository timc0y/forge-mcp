# Persistence architecture

Workspace state is explicit: requested, provisioning, bootstrapping, ready, busy, suspending, suspended, restoring, failed, destroying and destroyed.

D1 stores globally queryable metadata. The workspace Durable Object stores the hot revision, process and preview registry, lease, deduplication keys and recent event cursor. R2 stores immutable snapshots, screenshots, traces, large outputs and audit batches.

Snapshots include provider and image versions, repository state, exclusions and process definitions. Capabilities, injected secrets, sockets, browser auth and writable shared caches are excluded. Workflows will orchestrate suspend/restore/destruction because those operations must survive retries and Worker restarts.
