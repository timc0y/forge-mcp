# Credential profiles

Forge stores provider authentication as tenant-scoped credential profiles. A profile has a provider, a user-facing name, non-secret provider metadata, validation state, and one encrypted secret. It is deliberately separate from a workspace slot: a tenant may hold up to five profiles while Forge Cloud continues to enforce its independent workspace capacity.

## Encryption boundary

`@forge/credentials` is the only code that encrypts or decrypts profile secrets. It uses AES-256-GCM with a fresh 96-bit IV for every write. D1 receives a versioned encrypted envelope in `credential_profiles.encrypted_secret`; tools, the MCP app, logs, and D1 list queries expose only public profile fields.

Set `FORGE_CREDENTIAL_ENCRYPTION_KEY` as a Worker secret to a 32-byte base64url value. Do not add it to Wrangler `vars`, source control, or sandbox environment variables. Replacing the key requires an explicit migration/rotation procedure because existing ciphertext is intentionally unreadable with another key.

Secrets are decrypted only while a provider validates or uses them. The current Cloudflare provider validates through Cloudflare's token verification endpoint. A selected profile is recorded on a newly created workspace as profile identity only; its token is never mounted in a sandbox.

`forge_cloudflare_deploy` is the controlled path for a live Worker deploy. After human approval, Forge injects an **attached vault secret** that must include both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` into that one wrangler process only. The account id pins the deploy so a multi-account OAuth token cannot silently publish under the wrong `*.workers.dev` subdomain. Forge probes any published URL and returns a `deploy_receipt` — agents must not claim a Worker is live without `deploy_receipt.verified_url`. Ungated `wrangler deploy` via `forge_shell` is classified as `external_side_effect` and requires approval.

Create the secret with `forge_secret_create` (provider `cloudflare`) or the portal (`/app/secrets`), then `forge_secret_attach` (approval). Because Wrangler may execute repository-controlled hooks, approve deployments only for code you trust.

## Profile lifecycle

1. `forge_credential_create` normalizes provider input and encrypts the secret before persistence.
2. `forge_credential_validate` decrypts only for the provider request, then records `valid` or `invalid`.
3. `forge_credential_switch` selects a profile for the MCP session and marks it active for the tenant.
4. `forge_credential_update` resets validation after an authentication-affecting change.
5. `forge_credential_delete` removes the encrypted record permanently.

Migration `0018_credential_profiles.sql` is additive: existing tenants and workspaces remain valid, and `workspaces.credential_profile_id` is nullable for installations that have not selected a profile.

Migration `0019_workspace_recovery_and_capacity.sql` expands the Cloud workspace pool to five slots and records the last Forge commit successfully pushed. `forge_workspace_reconcile` always reads the repository before reporting that recorded state, and Forge blocks destruction while the worktree is dirty or the current branch has not been recorded as pushed.
