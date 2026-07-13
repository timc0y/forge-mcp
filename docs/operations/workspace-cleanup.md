# Workspace cleanup

Cleanup revokes preview routes and capabilities before stopping processes and destroying the sandbox. It persists selected artifacts/audit records, marks metadata destroyed and confirms provider removal. A periodic reconciler finds expired previews, stale ready workspaces, failed lifecycle workflows and orphaned provider instances.
