# process github webhook

Durable lifecycle definition for Forge. The executable Cloudflare Workflows entrypoints live in `apps/forge-edge-gateway/src/workflows.ts`; this directory records the product step contract and keeps workflow ownership visible.

Every step must be idempotent, bounded, retry-safe, observable and tied to a tenant, workspace, operation and trace identifier.
