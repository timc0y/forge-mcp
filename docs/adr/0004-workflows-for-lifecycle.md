# ADR 0004: Workflows for lifecycle operations

- **Status:** accepted, amended 2026-07-30
- **Lifecycle:** Provision/destruction use Cloudflare Workflows (multi-step, retryable, long-lived).
- **Execution:** Interactive commands use direct coordinator operations.
- **Constraints:** Executor suspend/restore workflows omitted; disposable executors re-materialize from GitHub.
- **Invariants:** Workflow activities must be idempotent and reconcile via workspace state.
