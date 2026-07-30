# ADR 0002: Cloudflare Sandbox SDK runtime

**Status:** accepted with beta controls; amended 2026-07-30

Use `@cloudflare/sandbox` rather than constructing a bespoke container control plane. Pin the SDK, isolate imports in `sandbox-cloudflare`, and run provider contract tests before version changes. Executors are disposable and re-materialize from GitHub; provider backup/restore is not part of the Forge interface. Raw provider IDs never cross the public API.
