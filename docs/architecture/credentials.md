# Credential profiles

Forge stores provider authentication as tenant-scoped vault secrets. A secret
has a provider, user-facing label, environment-variable names, and encrypted
values. It is deliberately separate from a workspace slot and can be attached
only through Forge's approval path.

## Encryption boundary

`@forge/credentials` is the only code that encrypts or decrypts secret values.
It uses AES-256-GCM with a fresh 96-bit IV for every write. D1 receives a
versioned encrypted envelope; tools, the MCP app, logs, and list queries expose
only labels, providers, and environment-variable names.

Set `FORGE_CREDENTIAL_ENCRYPTION_KEY` as a Worker secret to a 32-byte base64url value. Do not add it to Wrangler `vars`, source control, or sandbox environment variables. Replacing the key requires an explicit migration/rotation procedure because existing ciphertext is intentionally unreadable with another key.

Secrets are decrypted only for an approved operation that uses them. An
attachment records secret identity and workspace scope; values are injected
into the approved process only and never returned by MCP.

`forge_deploy` is the controlled path for a live deploy. Secrets stay generic
(arbitrary environment-variable names such as `CF_KEY`). After human approval,
Forge injects the attached vault vars into that one managed process. When the
CLI expects different names, the agent passes `map_env` — process env name →
attached vault var name — for example:

```json
{
  "CLOUDFLARE_API_TOKEN": "CF_KEY",
  "CLOUDFLARE_ACCOUNT_ID": "CF_ACCOUNT"
}
```

Forge does not maintain a Cloudflare alias list; the agent chooses the mapping
after `forge_secret_list`. For Cloudflare Wrangler, the process env must end up
with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (via storage names or
`map_env`) so the account is pinned and a multi-account token cannot silently
publish under the wrong `*.workers.dev` subdomain. Every call requires a stable
idempotency key. A slow run returns its `process_id` inside the host deadline;
after waiting, the same key reopens that process, probes the published URL, and
returns `deploy_receipt` without starting a second deploy. Agents must not claim
a Worker is live without `deploy_receipt.verified_url`. Ungated `wrangler deploy`
via `forge_shell` is classified as `external_side_effect` and requires approval.

Create the secret with `forge_secret_create` (provider may be `cloudflare` or
`generic`) or the portal (`/app/secrets`), then `forge_secret_attach` (approval).
Because Wrangler may execute repository-controlled hooks, approve deployments
only for code you trust.

## Secret lifecycle

1. `forge_secret_create` normalizes and encrypts values before persistence.
2. `forge_secret_list` returns metadata only; values are never recoverable
   through a read tool.
3. `forge_secret_update` replaces encrypted values or public metadata.
4. `forge_secret_attach` requires human approval before a workspace may use a
   secret; `attached:false` detaches it.
5. `forge_secret_delete` permanently removes the record and its attachments.
