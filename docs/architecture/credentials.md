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
(arbitrary environment-variable names). After human approval, Forge inspects the
**attached vault env names**, selects a known workflow, and injects normalized
credentials into that one managed process only.

Today the only built-in workflow is Cloudflare Wrangler. It matches when both an
API token and account id are present under any of these aliases:

- token: `CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_TOKEN`, `CF_TOKEN`
- account: `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCOUNT_ID`, `CLOUDFLARE_ACCOUNT`

Values are normalized to `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` for
Wrangler. The account id pins the deploy so a multi-account OAuth token cannot
silently publish under the wrong `*.workers.dev` subdomain. Every call requires
a stable idempotency key. A slow run returns its `process_id` inside the host
deadline; after waiting, the same key reopens that process, probes the published
URL, and returns `deploy_receipt` without starting a second deploy. Agents must
not claim a Worker is live without `deploy_receipt.verified_url`. Ungated
`wrangler deploy` via `forge_shell` is classified as `external_side_effect` and
requires approval.

`forge_cloudflare_deploy` remains as a thin alias that forces the Cloudflare
workflow. Prefer `forge_deploy` so the agent chooses from whatever env names are
attached.

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
