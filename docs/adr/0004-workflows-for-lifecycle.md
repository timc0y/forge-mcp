# ADR 0004: Workflows for lifecycle operations

**Status:** accepted, implementation gated

Provision, suspend, restore, PR creation and destruction become Cloudflare Workflows because they are multi-step, retryable and longer lived than one request. Interactive commands remain direct coordinator operations. Workflow activities are idempotent and reconcile through workspace state.
