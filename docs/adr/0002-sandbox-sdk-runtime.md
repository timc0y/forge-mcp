# ADR 0002: Cloudflare Sandbox SDK runtime

- **Status:** accepted with beta controls; amended 2026-07-30
- **Implementation:** Use `@cloudflare/sandbox` instead of custom container control planes.
- **Rules:** Pin SDK, isolate imports in `sandbox-cloudflare`, run provider contract tests pre-upgrade.
- **Invariants:** Executors are disposable (re-materialize from GitHub). Backup/restore excluded from interface. Raw provider IDs never cross public API.
