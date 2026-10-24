# Self-host Forge

Run your own Forge with your GitHub App, Cloudflare account and JEV credential.
The source and documentation are MIT licensed for reuse. Initial setup checks
ran locally on 23 October 2026; this guide has not been completed on a fresh
account. The maintainer's private deployment does not prove an independent
setup. See [release evidence](./going-live.md).

Tim's hosted endpoint and GitHub App are private for his own use. This guide
creates your own instance, with its own URL, App, access list and provider costs.

## What you operate and pay for

You operate a Worker, one D1 database, a SQLite Durable Object binding and the
single configured Cloudflare JEV route. Forge commits to GitHub; it does not
execute, build, test, serve or deploy repository code. GitHub automation can react
to those commits independently.

| Use | Who supplies the account and allowance |
|---|---|
| Tim's private deployment | Tim supplies his accounts and pays his Worker, D1, Durable Object, Browser Rendering and JEV costs; it is for his own use |
| ChatGPT or another client | You supply its plan; that does not include Forge hosting or JEV allowance, and client support must be checked separately |
| Your self-host | You pay your Cloudflare/JEV charges; repository owners supply GitHub permissions, API allowance and any Actions spend |

The capture attempt limit is per user and UTC day. JEV's daily call limit and
concurrency limit are shared across this deployment: defaults are 200 calls/day
and 4 simultaneous calls. Every inference attempt consumes the daily allowance;
an unknown outcome is not refunded and holds a fixed 60-second reservation. D1
stores aggregate attempts/completed/unknown/input/output counts and temporary
random reservations, without user IDs, source or paths. A missing budget backend
refuses inference. Completion accounting is bounded; validated evidence can return
with accounting still unknown without refunding the original attempt. Input/output
counts reflect reported usage; missing usage does not mean zero provider charge.
These limits count calls, not money: they are not a billing guarantee. Verify provider spend notifications and edge rate limits separately.

## 1. Install and make your config

Use Node within the root `package.json` range and its pinned pnpm version. From
the repository root:

```sh
pnpm --dir worker install --ignore-workspace --frozen-lockfile
cp worker/wrangler.self-host.example.jsonc worker/wrangler.self-host.jsonc
cp .dev.vars.example worker/.dev.vars
```

Replace the account, URL, App and `REPLACE_WITH_OWN_GITHUB_LOGIN` placeholders in
`worker/wrangler.self-host.jsonc`; step 3 supplies the new D1 database identifiers.
Both filled config variants and
`.dev.vars*` secret files are ignored; never put secret values in Wrangler `vars`. The example deliberately has no named
environment, maintainer routes, resource IDs or quota-exempt logins. All commands
below select it explicitly. Root `pnpm dev` and `pnpm run deploy` select the
maintainer config and are unsuitable for this setup.

The example uses `https://WORKER_NAME.YOUR_SUBDOMAIN.workers.dev` at the root of
the hostname. Choose the Worker name and your Cloudflare workers.dev subdomain,
and set `FORGE_PUBLIC_ORIGIN` to that exact HTTPS address, without a trailing `/`.
`account_id` and `CLOUDFLARE_ACCOUNT_ID` must both name your own account.

## 2. Register your GitHub App

Create the App under your own GitHub account or organisation. Set its homepage
and setup URL to your `FORGE_PUBLIC_ORIGIN`, and its OAuth callback to
`<FORGE_PUBLIC_ORIGIN>/oauth/callback`. The setup URL receives installation query
parameters; keep the entire Worker hostname routed if you later use a custom
domain. Forge does not consume webhooks; webhook delivery can remain disabled.

Enable **expiring user authorization tokens**. Fill `GITHUB_APP_CLIENT_ID` and
`GITHUB_APP_SLUG` from your registration and put its OAuth client secret in the
secret file. Copy the client ID exactly: GitHub's [App response example](https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app)
uses `Iv1.ab1112223334445c`; dotted and undotted IDs are accepted. No App private
key or installation-wide token is used. Each request
uses the signed-in person's stored, encrypted user credential: GitHub intersects
the person's permissions with the App's repository access.

| Repository permission | Why |
|---|---|
| Contents: read and write; Pull requests: read and write; Metadata: read | Read source, commit edits and prepare/review a proposal |
| Checks: read; Commit statuses: read; Actions: read | Exact-SHA execution evidence and repository-produced analysis artifacts |
| Administration: read and write | Required only if you want Forge to create repositories; existing-repository edits do not need it |
| Workflows: read and write | Required only for authorised edits to GitHub workflow files |

Install your App on a disposable repository you control. Approve changed
permissions in existing installations. Missing evidence permissions remain
explicitly unavailable; zero checks never mean success. A private App works for
its owning account; accepting other accounts requires a public registration and
their own installation/consent. The maintainer's private registration is not
reused by this setup.

## 3. Create your Cloudflare resources

Log Wrangler into your account, then run from `worker/`:

```sh
pnpm exec wrangler d1 create YOUR_DATABASE_NAME --config wrangler.self-host.jsonc
```

Copy that new database's name and ID into `d1_databases`, keeping binding
`METADATA` and `migrations_dir: "migrations"`. Keep `MCP_SESSIONS` bound to
`ForgeMcpSession` and the `v1` `new_sqlite_classes` migration: Wrangler creates the
Durable Object namespace on deployment. This is distinct from D1 SQL migrations.

```sh
pnpm exec wrangler d1 migrations apply METADATA --remote --config wrangler.self-host.jsonc
```

Apply all checked-in migrations, including `0004_semantic_budget.sql`, before
deploying code that uses the shared inference limits. `0002` retains legacy
capture ownership for deletion; new capture does not use an object store.

## 4. Set secrets and processing policy

Set `FORGE_ALLOWED_LOGINS` in your Wrangler config to your own GitHub login.
For example, `"FORGE_ALLOWED_LOGINS": "your-github-login"`. This is the service
access list: explicit logins, comma-separated and case-insensitive. Missing,
blank or any malformed entry denies everyone; there is no wildcard. Include
your login in local config too. GitHub OAuth, App installation and a capture
consent entry cannot grant access outside this list.

Generate `FORGE_SIGNING_KEY` from at least 32 random bytes (for example
`openssl rand -hex 32`). It signs tokens and approval links and derives the
GitHub-credential encryption key. Rotation invalidates all three and requires
reconnection. Use separate credentials for local development and production.

Set these values in ignored `worker/.dev.vars` for local checks and development:

- `GITHUB_APP_CLIENT_SECRET`: your App's OAuth client secret.
- `FORGE_SIGNING_KEY`: your random signing key.
- `CLOUDFLARE_API_TOKEN`: Browser Rendering permission scoped to your account.
- `TYPESAFE_API_KEY`: the credential admitted by your configured Cloudflare JEV route.
- `FORGE_DEV_AUTH_TOKEN`: a local bearer token, used only with a local/development config.

Set `TYPESAFE_BASE_URL` in Wrangler config to your admitted route with exactly
this shape: `https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/run`.
Use the account to which your JEV route/credential is granted; do not copy the
maintainer's route or substitute an arbitrary model endpoint. Forge requests
`typesafe/jev` and validates its Cloudflare output contract. Missing credentials,
an unavailable route, malformed responses and failed semantic stages are explicit
failures. There is no alternate provider, model or heuristic fallback. Exact
source reads and ordinary writes remain independent of inference.

`FORGE_JEV_PRIVATE_SOURCE` is an explicit operator policy. The template sets
`deny`: private source is refused before semantic processing. Change it to
`allow` only after informing users that bounded relevant private source and task
context are sent to the configured Cloudflare JEV route. GitHub handles identity
and repository operations; Cloudflare hosts Forge, D1, session state, public-page
rendering and configured inference. Review your processor terms, log retention
and public privacy notice before accepting other people's data. Shape-only logs
exclude source, paths, repository names, queries and user identifiers; frozen
approval evidence is retained separately in D1. See [operations](./operating-forge.md)
and [account deletion](./account-deletion.md) for retained data.

Before deployment, replace the support/deletion URL and displayed `timcoy.uk`
contact text in [privacy.ts](../worker/src/privacy.ts), and `operatorContact`
in [public-site.ts](../worker/src/public-site.ts), with your own operator contact.
Changing `FORGE_PUBLIC_ORIGIN` does not change these links. The footer's Tim Coy
byline is author attribution, separate from its Operator contact link.
Open `/privacy` and the homepage's Operator contact link: both must reach the
operator who controls your `METADATA` database and can carry out deletion.
The Forge maintainer cannot delete data from your installation.

Set `FORGE_CAPTURE_ALLOWED_LOGINS` to your own authenticated GitHub login only
if you consent to public-page capture. This is separate from `FORGE_ALLOWED_LOGINS`:
capture requires membership in both lists. You may explicitly add a separate
consenting user who already has service access, comma-separated. Empty or absent
denies all captures before quota/provider work; there is no wildcard or public
opt-out flag. Enabled accounts can capture arbitrary already-public URLs. This
restriction limits who can call the provider; it does not establish provider
DNS, redirect or subrequest isolation. Retiring it requires actual provider proof
and an explicit release change. Keep private-page capture out of scope.

From `worker/`, check locally without network calls or deployment:

```sh
node scripts/check-config.mjs --config wrangler.self-host.jsonc --secrets-file .dev.vars
```

The checker parses JSONC, refuses placeholders and retained maintainer
identifiers, requires a valid nonempty `FORGE_ALLOWED_LOGINS` list, checks
routes/resources/bindings/policies, and checks required secret
presence. It prints field names and errors, never values. It cannot prove token
scope, App grants, a working JEV route, provider isolation or deployed state.
`--config-only` explicitly skips credentials. With no `--secrets-file` it checks
the process environment; it never fetches deployed secrets.

Upload production secrets interactively, from `worker/`:

```sh
pnpm exec wrangler secret put GITHUB_APP_CLIENT_SECRET --config wrangler.self-host.jsonc
pnpm exec wrangler secret put FORGE_SIGNING_KEY --config wrangler.self-host.jsonc
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN --config wrangler.self-host.jsonc
pnpm exec wrangler secret put TYPESAFE_API_KEY --config wrangler.self-host.jsonc
```

Do not upload `FORGE_DEV_AUTH_TOKEN` to production or set a GitHub private key.
The deployment login and the runtime Browser Rendering token have separate jobs,
even when a deployment subprocess uses the same environment variable name.

## 5. Check, deploy and connect

From the root, `pnpm check` checks TypeScript, Vitest and the focused Node
setup/runbook regressions. The root Node range is `>=22.18.0 <27`. To run only
these fixtures, use `node --test worker/scripts/*.node-test.mjs`. Then from `worker/`:

```sh
pnpm exec wrangler deploy --config wrangler.self-host.jsonc
```

Open `<FORGE_PUBLIC_ORIGIN>/health` and verify the returned version, then open
the landing and `/privacy` pages and check OAuth discovery. Connect your client
to `<FORGE_PUBLIC_ORIGIN>/mcp`, authorise your App and install it on your
disposable repository. A deployment is not a client refresh. Refresh/re-scan
the connection and start a new conversation after catalog changes; record the
client, plan, surface, version and date. See the [release status](./going-live.md).

## 6. Prove one useful read and edit

Ask for the disposable repository's `README.md` with an exact path. Confirm
the result includes the immutable source SHA and the expected content. Then
explicitly authorise one harmless marker edit in that disposable repository:

> In `MY_LOGIN/DISPOSABLE_REPO`, add `Forge self-host check: DATE` to README.md
> directly on the default branch.

Inspect the returned branch, full commit SHA and GitHub URL. Open that actual
GitHub commit and confirm the repository, branch, marker diff and resulting
README at that SHA. Read the exact path back at the returned SHA. A successful
tool envelope alone does not prove the GitHub write. Record this evidence before
claiming your installation works. This guide's author has not performed this
fresh-account journey.

For review, explicitly ask for a proposal; it uses the one fixed `forge` branch.
Only merge/discard require a human approval link. Open and approve each on a
disposable proposal and verify GitHub's resulting commit or deletion separately.
Screenshots, if enabled for your login, return inline; there is no gallery or
30-day screenshot-link retention contract.

## Local development

Copy your filled config to `worker/wrangler.self-host.local.jsonc`. Set
`FORGE_ENVIRONMENT` to `local` and `FORGE_PUBLIC_ORIGIN` to
`http://localhost:8787`. From `worker/`:

```sh
node scripts/check-config.mjs --config wrangler.self-host.local.jsonc --secrets-file .dev.vars --local
pnpm exec wrangler d1 migrations apply METADATA --local --config wrangler.self-host.local.jsonc
pnpm exec wrangler dev --local --config wrangler.self-host.local.jsonc
```

This uses `.dev.vars` beside the config, with no named environment. The
maintainer's `pnpm dev` selects `--env development`; that instead needs the
complete `worker/.dev.vars.development`, which replaces `.dev.vars` when present.

A freshly migrated local D1 database has no users. **Complete GitHub OAuth once
against this local Worker and its local `METADATA` database before using the
development bearer token.** Authorising the production Worker populates its
remote database and does not create a local user.

Register `http://localhost:8787/oauth/callback` on your own development GitHub
App, and use that App's client ID and secret in the local config/secret file.
With the local Worker running, connect an OAuth-capable client that can reach
`http://localhost:8787/mcp`, without the development bearer token, and complete
GitHub authorisation. Keep the same local config and database persistence when
returning to development bearer authentication.

The development token must resolve an existing allowed local user; use
your own single-user development database and include your login in
`FORGE_ALLOWED_LOGINS`. With no allowed user, development bearer access is
refused even when the token matches. Do not insert GitHub tokens
by hand or create a default user to bypass OAuth. Local bearer authentication
does not itself test OAuth or populate the database. This bootstrap is required
setup, not a newly verified OAuth journey; local checks do not establish deployed
budget, edge/spend configuration, provider isolation or a fresh client journey.
