# Cloudflare Workflows research

- Product: Cloudflare Workflows, configured by Wrangler and Worker bindings
- Version surface: Wrangler 4.110.0 configuration and `cloudflare:workers` `WorkflowEntrypoint`
- Maturity: production platform primitive
- Used surface: deterministic workflow instance IDs and retryable provisioning/destruction steps
- Selected for retry-safe multi-step lifecycle operations that must outlive one MCP request
- Fallback: workspace coordinator plus Queues for bounded recovery
- Risk: step payload/version migration and accidentally non-idempotent activities
- Verified: 2026-07-12 against official docs and generated Wrangler types
- Current limitation: suspension, restoration and PR workflows remain contracts/roadmap entries rather than enabled production paths
