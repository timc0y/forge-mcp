# Cloudflare Sandbox SDK research

- Repository: `cloudflare/sandbox-sdk`
- Package/version: `@cloudflare/sandbox` 0.12.3
- Maturity: beta
- Used surface: `getSandbox`, explicit sessions, command/file/process APIs, port exposure, proxying and destroy
- Selected because it supplies the Linux runtime and lifecycle primitives Forge needs without a bespoke scheduler
- Fallback: `LocalDockerSandboxProvider` for development; future external provider
- Risk: pre-1.0 API and snapshot compatibility changes
- Verified: 2026-07-12 against official repository and docs
- Limitations: local Docker is not production parity; preview behavior depends on Cloudflare deployment. Backup/restore is deliberately unused because executors are disposable.
