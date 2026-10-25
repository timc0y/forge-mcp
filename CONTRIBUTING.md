# Contributing to Forge

Send a focused pull request for a fix or documentation change. For a bug, include
what you expected, what happened, the source commit or deployed version, and
steps that reproduce it. Use [private reporting](./SECURITY.md) for security
issues.

## Install and check

Read [SIMPLE.md](./SIMPLE.md) for the product boundaries and
[the context-engine plan](./docs/plans/context-engine.md) for the active
architecture. Current implementation lives in `worker/`.

Use Node `>=22.18.0 <27` and pnpm `10.13.1`, as declared in
[`package.json`](./package.json). CI uses Node 22. From the repository root:

```sh
pnpm --dir worker install --ignore-workspace --frozen-lockfile
pnpm check
```

The Worker installs independently; there are no workspace dependencies.
`pnpm check` runs TypeScript, Vitest and the Node fixtures. To run one part:

```sh
pnpm typecheck
pnpm test
node --test worker/scripts/*.node-test.mjs
```

[CI](./.github/workflows/ci.yml) also checks the Worker bundle and startup.

## Run your own Worker

Follow [self-hosting](./docs/self-hosting.md) for your own GitHub App, Cloudflare
resources, credentials and configuration.

Root `pnpm dev` selects the local-only `worker/wrangler.jsonc`. Deployment uses
your ignored `worker/wrangler.self-host.jsonc`; follow the self-hosting guide.

## Prepare a pull request

Keep the change to one problem. Explain the resulting behaviour, the checks you
ran and any remaining issues. Include regression coverage for behaviour
changes and update the documentation that describes them.

Tool, schema or instruction changes need a server-version release and a client
refresh. Follow the [release checklist](./docs/going-live.md).

Keep secrets, filled self-host configs, personal data and private repository
content out of issues, pull requests and screenshots. The
[MIT licence](./LICENSE) covers project code and documentation; dependencies
retain their own licences and notices.

Main requires the GitHub Actions `check` result and blocks force-pushes and
deletion. Repository administrators retain an explicit bypass for recovery;
record why it was needed. Report vulnerabilities through [SECURITY.md](./SECURITY.md).
