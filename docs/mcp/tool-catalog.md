# Tool catalog

Forge exposes workspace, repository, file, shell, process, Git, preview, browser evidence, approval, and artifact tools. Machine-readable schemas are generated into `schemas/forge-tools.schema.json`.

## Credentials, recovery, and deployment

- `forge_credential_list`, `forge_credential_create`, `forge_credential_update`, `forge_credential_delete`, `forge_credential_switch`, and `forge_credential_validate` manage tenant-scoped encrypted provider profiles. They never return a secret or ciphertext.
- `forge_workspace_reconcile` reads the checkout and reports whether Forge has recorded the current commit as pushed. Run it after reconnecting before continuing an interrupted task.
- `forge_cloudflare_deploy` runs `pnpm exec wrangler deploy` only after approval, using the selected validated Cloudflare profile as an ephemeral command environment. It supports an optional Wrangler environment and config path.

Push remains approval-gated. Forge can reliably report local unpushed work, but it must not automatically publish a branch without the authenticated user's explicit approval.
