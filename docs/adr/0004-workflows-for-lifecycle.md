# ADR 0004: Workflows for lifecycle operations

**Status:** accepted, amended 2026-07-30

Provision and destruction use Cloudflare Workflows because they are multi-step, retryable and longer lived than one request. Interactive commands remain direct coordinator operations. Executor suspend/restore workflows are deliberately absent: disposable executors re-materialize from GitHub. Workflow activities are idempotent and reconcile through workspace state.
