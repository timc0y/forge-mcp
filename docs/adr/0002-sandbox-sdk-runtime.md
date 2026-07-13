# ADR 0002: Cloudflare Sandbox SDK runtime

**Status:** accepted with beta controls

Use `@cloudflare/sandbox` rather than constructing a bespoke container control plane. Pin the SDK, isolate imports in `sandbox-cloudflare`, run provider contract tests, persist provider version in snapshots and require upgrade fixtures before version changes. Raw provider IDs never cross the public API.
