# Credential profiles

Forge stores provider authentication as tenant-scoped vault secrets (provider, label, env var names, encrypted values), decoupled from workspace slots and attached via human approval.

## Encryption & Security Boundary

| Property | Specification / Rule |
| :--- | :--- |
| **Engine** | `@forge/credentials` (exclusive encryption/decryption module) |
| **Cipher** | AES-256-GCM with fresh 96-bit IV per write |
| **Key Secret** | `FORGE_CREDENTIAL_ENCRYPTION_KEY` (32-byte base64url Worker secret) |
| **Key Restrictions** | Forbidden in Wrangler `vars`, source control, or sandbox env vars |
| **Key Rotation** | Requires explicit migration; ciphertext unreadable with new key |
| **Persistence** | D1 stores versioned encrypted envelope |
| **Exposure Scope** | Tools, MCP app, logs, & list queries expose metadata only (labels, providers, env names) |
| **Runtime Injection** | Decrypted only for approved operation; injected into managed process, never returned via MCP |

## Deployment & Agent Flow

### Controlled Path (`forge_deploy`)

1. `forge_secret_list` — Query secret metadata (labels, env var names).
2. `forge_secret_accounts` — Pass `token_var` (e.g. `CF_KEY`). Forge calls Cloudflare API; returns account `id` + `name`.
3. **User Selection** — Prompt user to select target account ID.
4. `forge_secret_update` — Apply `env: { CLOUDFLARE_ACCOUNT_ID: "<chosen>" }` (patches merge; token untouched).
5. `forge_secret_attach` & `forge_deploy` — Pass `map_env` if vault names differ from CLI (e.g. `{"CLOUDFLARE_API_TOKEN": "CF_KEY"}`).

### Wrangler & Execution Rules

- **Env Mapping**: Wrangler process env requires `CLOUDFLARE_API_TOKEN` (direct name or via `map_env`). Option to map `CLOUDFLARE_ACCOUNT_ID` if stored under another name. Forge maintains no Cloudflare alias list; agent chooses mapping after `forge_secret_list`.
- **Account Pinning**: `CLOUDFLARE_ACCOUNT_ID` pins account in approval/receipt to prevent multi-account token silent publishing to wrong `*.workers.dev` subdomain. Defaults to wrangler config or token default if omitted. Prefer prompting via `forge_secret_accounts` when token sees >1 account.
- **Idempotency**: All calls require stable idempotency key. Slow runs return `process_id` before host deadline; retry with same key reopens process, probes URL, & returns `deploy_receipt` without starting a second deploy.
- **Verification Gate**: Agents must not mark Worker live without `deploy_receipt.verified_url`.
- **Policy Enforcement**: Ungated `wrangler deploy` via `forge_shell` is classified as `external_side_effect` (requires approval).
- **Hook Risk**: Wrangler executes repo-controlled hooks; approve deployments only for trusted code.
- **Creation Tools**: Create secrets via `forge_secret_create` (`provider`: `cloudflare` \| `generic`) or portal (`/app/secrets`).

## Secret Lifecycle API

| API Tool / Action | Operations & Semantics |
| :--- | :--- |
| `forge_secret_create` | Normalizes and encrypts values prior to D1 persistence. |
| `forge_secret_list` | Returns metadata only; secret values are non-recoverable via read tools. |
| `forge_secret_update` | Merges env patches (e.g., adding `CLOUDFLARE_ACCOUNT_ID`) or removes keys via `unset_env`. |
| `forge_secret_accounts` | Queries Cloudflare API with stored token to list `id` + `name` options without exposing token. |
| `forge_secret_attach` | Requires human approval before workspace use (`attached:false` detaches). |
| `forge_secret_delete` | Permanently deletes secret record and all workspace attachments. |
