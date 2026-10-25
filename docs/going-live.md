# Release verification

Source checks, a deployment and a working client connection are separate evidence.
Run these checks for your own instance before relying on it.

## Source checks

Run `pnpm check` for TypeScript, runtime tests and Node fixtures. Follow the
bundle and startup checks in [operations](./operating-forge.md). Record the exact
commit, commands and results privately alongside your deployment configuration.

## Deployment checks

Follow [self-hosting](./self-hosting.md), apply migrations, deploy and check
`<FORGE_PUBLIC_ORIGIN>/health`. Run the smoke script with your explicit origin.
Verify query-string log redaction, rate limits and provider spending alerts.
A successful upload does not establish OAuth, repository grants or client support.

## Client checks

Refresh or reconnect your MCP client after a version or tool-schema change.
In a new conversation, read a disposable repository, commit a document and verify
the commit on GitHub. Exercise a proposed change, merge and discard through the
human approval links. Confirm an account outside the allowlist cannot connect.
Client plans and supported surfaces change; verify the client you intend to use.

## Remaining limits

Independent fresh-account setup is unverified. Capture remains restricted to
explicitly enabled, consenting accounts: provider DNS, redirect and subrequest
isolation is not established by source tests. Semantic quality and provider spend
need their own evidence. Keep operator URLs, account IDs and test receipts out of
public source and documentation.
